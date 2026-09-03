/**
 * Browser capture → FFmpeg → streaming output.
 *
 * Flow:
 *   1. Launch Chromium (headful via Xvfb in Docker)
 *   2. puppeteer-stream captures page audio/video as WebM
 *   3. FFmpeg encodes and pushes to outputUrl (SRT, RTMP, file, etc.)
 *
 * Config is read from config.json — see config.example.json.
 */
import { spawn, ChildProcess } from "child_process";
import puppeteer from "puppeteer";
import { getStream, launch, wss } from "puppeteer-stream";

import {
	enableAutoplayOnPage,
	clickPlayTarget,
	hideScrollbarsOnPage,
	kickExistingMedia,
	AUTOPLAY_LAUNCH_ARGS,
} from "./autoplay.js";
import { loadConfig, type StreamerConfig } from "./config.js";
import { buildFfmpegArgs } from "./ffmpeg.js";
import { error, log } from "./logger.js";

/** puppeteer-stream bundles puppeteer-core 24; types must come from `launch()`, not puppeteer 25. */
type Browser = Awaited<ReturnType<typeof launch>>;

/** Held at module scope so SIGINT/SIGTERM handlers can clean up. */
let browser: Browser | null = null;
let ffmpeg: ChildProcess | null = null;
let shuttingDown = false;

/** Tear down FFmpeg, Chromium, and puppeteer-stream's internal WebSocket server. */
async function shutdown(): Promise<void> {
	// Kill the FFmpeg process if it is not killed
	if (ffmpeg && !ffmpeg.killed) {
		ffmpeg.kill("SIGTERM");
	}

	// Close the browser if it is not closed
	if (browser) {
		await browser.close();
		browser = null;
	}

	// Close the WebSocket server if it is not closed
	try {
		(await wss).close();
	} catch {
		// Already closed on normal exit — safe to ignore.
	}
}

/** Stop the pipeline and exit — no-op if shutdown is already in progress. */
async function exitPipeline(exitCode: number, message?: string, err?: unknown): Promise<void> {
	// If the shutdown is already in progress, return
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;

	// If the message is available, log the error
	if (message) {
		if (err !== undefined) {
			error(message, err);
		} else {
			error(message);
		}
	}

	// Shutdown the pipeline and exit the process
	await shutdown();
	process.exit(exitCode);
}

/** Wire fatal-error handlers once capture and FFmpeg are running. */
function watchPipeline(stream: NodeJS.ReadableStream): void {
	// If the browser is disconnected unexpectedly, exit the process
	browser?.on("disconnected", () => {
		void exitPipeline(1, "Browser disconnected unexpectedly");
	});

	// If the capture stream errors, exit the process
	stream.on("error", (err: Error) => {
		void exitPipeline(1, "Capture stream error", err);
	});

	// If the FFmpeg process errors, exit the process
	ffmpeg?.on("error", (err: Error) => {
		void exitPipeline(1, "FFmpeg process error", err);
	});

	// If the FFmpeg process closes, exit the process
	ffmpeg?.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
		log(`FFmpeg process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
		if (!shuttingDown) {
			const failed = code !== 0 || signal !== null;
			void exitPipeline(failed ? 1 : 0, failed ? "FFmpeg exited with an error" : undefined);
		}
	});

	// If the FFmpeg stdin errors, exit the process
	ffmpeg?.stdin?.on("error", (err: NodeJS.ErrnoException) => {
		// EPIPE is normal when FFmpeg exits before the capture stream finishes.
		if (!shuttingDown && err.code !== "EPIPE") {
			void exitPipeline(1, "FFmpeg stdin error", err);
		}
	});
}

/**
 * Starts the streaming process.
 * @param config - The configuration for the streaming process.
 * @returns A promise that resolves when the streaming process is started.
 * @throws An error if the streaming process fails to start.
 */
async function startStreaming(config: StreamerConfig): Promise<void> {
	try {
		log("Launching browser...");

		// launch() from puppeteer-stream loads the browser extension required for capture.
		// executablePath() is async in Puppeteer 24+ — must be awaited or launch sees "[object Promise]".
		const executablePath = await puppeteer.executablePath();
		log(`Using Chromium at ${executablePath}`);
		const launched = await launch({
			executablePath,
			headless: config.puppeteer.headless,
			args: [...AUTOPLAY_LAUNCH_ARGS, ...config.puppeteer.args],
			defaultViewport: {
				width: config.width,
				height: config.height,
			},
		});
		browser = launched;

		// Create a new page
		const page = await launched.newPage();

		// Allow video/audio autoplay without user clicks (see autoplay.ts).
		await enableAutoplayOnPage(page);

		if (config.hideScrollbars) {
			await hideScrollbarsOnPage(page);
		}

		// Navigate to the target URL
		log(`Navigating to ${config.targetUrl}...`);
		await page.goto(config.targetUrl, { waitUntil: "networkidle2" });

		// If a click play target is configured, click it
		if (config.clickPlayTarget) {
			log(`Clicking play target ${config.clickPlayTarget}...`);
			await clickPlayTarget(page, config.clickPlayTarget);
		}

		// Kick any existing media that was already on the page when navigation finished
		await kickExistingMedia(page);

		// getStream() returns a Node readable stream of WebM chunks from the page.
		// frameSize is milliseconds per packet (inverse of frame rate).
		const stream = await getStream(page, {
			audio: config.stream.audio,
			video: config.stream.video,
			frameSize: Math.round(1000 / config.frameRate),
		});

		log("Browser capture initialized. Connecting to FFmpeg...");

		// Build the FFmpeg CLI args
		const ffmpegArgs = buildFfmpegArgs(config);
		const outputTarget = ffmpegArgs.at(-1);
		if (!outputTarget || outputTarget === "undefined") {
			throw new Error(
				`FFmpeg output URL is missing (got "${outputTarget}"). Rebuild the image: bun run docker:build`,
			);
		}
		log(`FFmpeg: ffmpeg ${ffmpegArgs.join(" ")}`);

		// Spawn the FFmpeg process
		ffmpeg = spawn("ffmpeg", ffmpegArgs);

		// If the FFmpeg stderr is available, log the data
		ffmpeg.stderr?.on("data", (data: Buffer) => {
			for (const line of data.toString().trimEnd().split("\n")) {
				if (line) {
					log(`[FFmpeg] ${line}`);
				}
			}
		});

		// If the FFmpeg stdin is not available, throw an error
		if (!ffmpeg.stdin) {
			throw new Error("FFmpeg stdin is not available");
		}

		// Watch the pipeline
		watchPipeline(stream);
		// Pipe the stream to the FFmpeg stdin
		stream.pipe(ffmpeg.stdin);

		log(`Streaming live to ${config.outputUrl}...`);
	} catch (err) {
		await exitPipeline(1, "Streaming error", err);
	}
}

// Handle SIGINT (Ctrl+C)
process.on("SIGINT", () => {
	log("Shutting down...");
	void exitPipeline(0);
});

// Handle SIGTERM (Terminate)
process.on("SIGTERM", () => {
	log("Shutting down...");
	void exitPipeline(0);
});

// Load the configuration and start the streaming process on startup
log(`Loading config from ${process.env.CONFIG_PATH ?? `${process.cwd()}/config.json`}...`);
const config = await loadConfig();
log(`Output: ${config.outputUrl} | video: ${config.ffmpeg.videoCodec} | format: ${config.ffmpeg.format}`);
await startStreaming(config);
