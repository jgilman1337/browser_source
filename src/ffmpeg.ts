/**
 * FFmpeg child process: spawn, pipe capture into stdin, and retry on drop / timeout / refused.
 *
 * CLI args come from `ffmpeg_config.ts`. Chromium is owned by `index.ts` and is not relaunched here.
 */
import { spawn, type ChildProcess } from "child_process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { StreamerConfig } from "./config.js";
import { buildFFmpegArgs } from "./ffmpeg_config.js";
import { error, log } from "./logger.js";

/**
 * Callbacks into the capture pipeline so this module does not import `index.ts`
 * (that would be a circular dependency).
 */
export type FFmpegRuntimeHooks = {
	/** True after SIGINT/SIGTERM/`exitPipeline` — retries must not spawn another process. */
	isShuttingDown: () => boolean;
	/** Tear down Chromium + FFmpeg and exit the process. */
	exitPipeline: (exitCode: number, message?: string, err?: unknown) => Promise<void>;
};

/**
 * Current FFmpeg child. Event handlers compare `proc !== ffmpeg` so a process we already
 * replaced (or killed during retry) cannot start a second retry.
 */
let ffmpeg: ChildProcess | null = null;
/**
 * Page capture stream from puppeteer-stream. Kept alive across FFmpeg restarts and
 * re-piped into each new stdin. If this ends, retries are impossible and we exit.
 */
let captureStream: Readable | null = null;
/** Cached `buildFFmpegArgs()` result so retries spawn with the same CLI. */
let ffmpegArgs: string[] = [];
/**
 * Consecutive FFmpeg failures since the last stable run.
 * Compared against `config.ffmpeg.retries` (extra launches after the first failure).
 */
let ffmpegFailures = 0;
/**
 * True while `handleFFmpegFailure` is running. FFmpeg often emits `error`, `close`, and
 * stdin `EPIPE` for one death — this makes that a single retry.
 */
let ffmpegRestarting = false;
/** Timer that clears `ffmpegFailures` after FFmpeg has stayed up for `FFMPEG_STABLE_MS`. */
let ffmpegStableTimer: ReturnType<typeof setTimeout> | null = null;
/** Set when `connectFFmpeg` runs; used by retry handlers. */
let hooks: FFmpegRuntimeHooks | null = null;

/**
 * After FFmpeg stays up this long, consecutive retry counts reset.
 * A listener that is down for a few minutes still uses the retry budget; a drop hours
 * later starts from zero again.
 */
const FFMPEG_STABLE_MS = 15_000;

function requireHooks(): FFmpegRuntimeHooks {
	if (!hooks) {
		throw new Error("FFmpeg runtime hooks are not initialized");
	}
	return hooks;
}

/** Cancel a pending stable-reset so a crash during the window still counts as consecutive. */
function clearFFmpegStableTimer(): void {
	if (ffmpegStableTimer) {
		clearTimeout(ffmpegStableTimer);
		ffmpegStableTimer = null;
	}
}

/** Schedule a reset of `ffmpegFailures` once this FFmpeg instance has been healthy long enough. */
function markFFmpegStableSoon(): void {
	clearFFmpegStableTimer();
	ffmpegStableTimer = setTimeout(() => {
		ffmpegFailures = 0;
		ffmpegStableTimer = null;
	}, FFMPEG_STABLE_MS);
}

/**
 * Unpipe capture and SIGTERM FFmpeg. Call from pipeline shutdown so the readable is not destroyed
 * before Chromium closes.
 */
export function stopFFmpeg(): void {
	clearFFmpegStableTimer();

	if (captureStream && ffmpeg?.stdin) {
		captureStream.unpipe(ffmpeg.stdin);
	}

	if (ffmpeg && !ffmpeg.killed) {
		ffmpeg.kill("SIGTERM");
	}

	ffmpeg = null;
}

/**
 * Spawn FFmpeg, pipe the existing capture stream into stdin, and attach retry watchers.
 *
 * @param config - Resolved streamer config (used by FFmpeg watchers for retries / retryAfter).
 * @throws If stdin or the capture stream is missing.
 */
function spawnFFmpeg(config: StreamerConfig): void {
	const proc = spawn("ffmpeg", ffmpegArgs);
	ffmpeg = proc;

	// Forward FFmpeg's own logs (stats, SRT errors, encoder warnings) into our logger
	proc.stderr?.on("data", (data: Buffer) => {
		for (const line of data.toString().trimEnd().split("\n")) {
			if (line) {
				log(`[FFmpeg] ${line}`);
			}
		}
	});

	if (!proc.stdin) {
		throw new Error("FFmpeg stdin is not available");
	}
	if (!captureStream) {
		throw new Error("Capture stream is not available");
	}

	// WebM chunks from the page → FFmpeg stdin. Same readable is reused after a retry.
	captureStream.pipe(proc.stdin);
	watchFFmpeg(proc, config);
	markFFmpegStableSoon();
}

/**
 * Retry FFmpeg on spawn failure, process `close`, or stdin errors (connection drop, timeout, refused).
 * Ignore events from a superseded child (`proc !== ffmpeg`) so a kill during retry is a no-op.
 *
 * @param proc - The child these listeners belong to (must still be the global `ffmpeg` to act).
 * @param config - Supplies `ffmpeg.retries` and `ffmpeg.retryAfter`.
 */
function watchFFmpeg(proc: ChildProcess, config: StreamerConfig): void {
	const { isShuttingDown } = requireHooks();

	// Spawn failed (ENOENT, etc.) — not the same as FFmpeg exiting after a refused SRT connect
	proc.on("error", (err: Error) => {
		if (proc !== ffmpeg) {
			return;
		}
		void handleFFmpegFailure(config, "FFmpeg process error", err);
	});

	// Process exited. SRT "connection refused" / timeout usually shows up here as a non-zero code.
	proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
		if (proc !== ffmpeg) {
			return;
		}
		log(`FFmpeg process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
		if (isShuttingDown()) {
			return;
		}
		// Live encodes should not exit 0; treat a clean close as unexpected and retry.
		const failed = code !== 0 || signal !== null;
		void handleFFmpegFailure(config, failed ? "FFmpeg exited with an error" : "FFmpeg exited unexpectedly");
	});

	proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
		// EPIPE races with `close` when FFmpeg dies; `close` owns the retry.
		if (proc !== ffmpeg || isShuttingDown() || err.code === "EPIPE") {
			return;
		}
		void handleFFmpegFailure(config, "FFmpeg stdin error", err);
	});
}

/**
 * Unpipe capture, wait `ffmpeg.retryAfter` seconds, and spawn FFmpeg again.
 * Does not relaunch Chromium. Exits the process when `ffmpeg.retries` consecutive
 * failures are used up, or if the capture stream has already ended.
 *
 * @param config - Resolved streamer config (`ffmpeg.retries`, `ffmpeg.retryAfter`, `outputUrl`).
 * @param message - Human-readable reason for this failure (included in logs / final exit).
 * @param err - Optional underlying error from spawn / stdin.
 */
async function handleFFmpegFailure(config: StreamerConfig, message: string, err?: unknown): Promise<void> {
	const { isShuttingDown, exitPipeline } = requireHooks();

	// SIGTERM or an overlapping handler (error + close) is already driving shutdown/retry
	if (isShuttingDown() || ffmpegRestarting) {
		return;
	}
	ffmpegRestarting = true;
	clearFFmpegStableTimer();

	// Drop the global pointer first so this child's `close` after SIGTERM is ignored.
	const proc = ffmpeg;
	ffmpeg = null;
	if (captureStream && proc?.stdin) {
		captureStream.unpipe(proc.stdin);
	}
	if (proc && !proc.killed) {
		proc.kill("SIGTERM");
	}

	const { retries, retryAfter } = config.ffmpeg;
	if (ffmpegFailures >= retries) {
		ffmpegRestarting = false;
		await exitPipeline(1, `${message} (exhausted ${retries} retries)`, err);
		return;
	}

	ffmpegFailures += 1;
	const retryMsg = `${message}. Retry ${ffmpegFailures}/${retries} in ${retryAfter}s...`;
	if (err !== undefined) {
		error(retryMsg, err);
	} else {
		log(retryMsg);
	}

	// Give the stream listener time to come back (or the network to recover)
	if (retryAfter > 0) {
		await delay(retryAfter * 1000);
	}
	if (isShuttingDown()) {
		ffmpegRestarting = false;
		return;
	}

	const stream = captureStream;
	if (!stream || stream.readableEnded || stream.destroyed) {
		ffmpegRestarting = false;
		await exitPipeline(1, "Capture stream ended; cannot restart FFmpeg");
		return;
	}

	try {
		spawnFFmpeg(config);
		log(`Streaming live to ${config.outputUrl}...`);
	} catch (spawnErr) {
		ffmpegRestarting = false;
		await handleFFmpegFailure(config, "FFmpeg respawn failed", spawnErr);
		return;
	}

	ffmpegRestarting = false;
}

/**
 * Build FFmpeg args, pipe `stream` into a new process, and retry according to config.
 *
 * @param config - Fully resolved streamer config.
 * @param stream - puppeteer-stream WebM capture (kept for retries).
 * @param runtime - Shutdown / exit callbacks from `index.ts`.
 */
export async function connectFFmpeg(
	config: StreamerConfig,
	stream: Readable,
	runtime: FFmpegRuntimeHooks,
): Promise<void> {
	hooks = runtime;
	captureStream = stream;

	ffmpegArgs = buildFFmpegArgs(config);
	const outputTarget = ffmpegArgs.at(-1);
	if (!outputTarget || outputTarget === "undefined") {
		throw new Error(
			`FFmpeg output URL is missing (got "${outputTarget}"). Rebuild the image: npm run docker:build`,
		);
	}
	log(`FFmpeg: ffmpeg ${ffmpegArgs.join(" ")}`);

	try {
		spawnFFmpeg(config);
	} catch (err) {
		// Spawn can fail before `close` (missing binary / no stdin) — same retry path as a later drop.
		await handleFFmpegFailure(config, "FFmpeg failed to start", err);
	}
}
