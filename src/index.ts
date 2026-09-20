/**
 * Browser capture → FFmpeg → streaming output.
 *
 * Flow:
 *   1. Launch Chromium (headful via Xvfb in Docker)
 *   2. puppeteer-stream captures page audio/video as WebM
 *   3. FFmpeg encodes and pushes to outputUrl (SRT, RTMP, file, etc.)
 *   4. If FFmpeg dies (drop, timeout, connection refused), it is respawned
 *      indefinitely, waiting `ffmpeg.retryAfter` seconds between attempts.
 *      Chromium stays up so a listener restart does not reload the page.
 *
 * Config is read from config.json — see config.example.json.
 */
import type { Readable } from "node:stream";
import type { Server } from "node:http";
import puppeteer from "puppeteer";
import { getStream, launch, wss } from "puppeteer-stream";

import {
	enableAutoplayOnPage,
	clickPlayTarget,
	hideScrollbarsOnPage,
	kickExistingMedia,
	loadMediaStreamTarget,
	navigateToTarget,
	AUTOPLAY_LAUNCH_ARGS,
} from "@/browser/autoplay";
import { loadConfig, type StreamerConfig } from "@/config";
import { error, log } from "@/platform/logger";
import { runtimeName } from "@/platform/runtime";
import { resolveAdminPassword } from "@/platform/auth";
import "@/platform/uptime";
import { startControlServer, stopControlServer } from "@/http/server";
import { PersistentFFmpegRelay } from "@/streaming/relay";

/** puppeteer-stream bundles puppeteer-core 24; types must come from `launch()`, not puppeteer 25. */
type Browser = Awaited<ReturnType<typeof launch>>;

/** Held at module scope so SIGINT/SIGTERM handlers can clean up. */
let browser: Browser | null = null;
/** HTTP control server, closed before the browser during shutdown. */
let controlServer: Server | null = null;
/** Persistent media relay, which owns the uninterrupted downstream output. */
let mediaRelay: PersistentFFmpegRelay | null = null;
/** Once true, retries stop and SIGINT/SIGTERM/`close` must not spawn another FFmpeg. */
let shuttingDown = false;
/** True while an intentional page reload is replacing the current capture. */
let reloadingPage = false;
/** Current capture stream; stale streams must not terminate the live pipeline. */
let activeCapture: Readable | null = null;
/** Assigned after the capture page exists so the HTTP server can trigger reloads. */
let reloadPage: (() => Promise<void>) | null = null;

/** Tear down FFmpeg, Chromium, and puppeteer-stream's internal WebSocket server. */
async function shutdown(): Promise<void> {
	// Stop accepting administrative requests before tearing down the pipeline.
	await stopControlServer(controlServer);
	controlServer = null;
	await mediaRelay?.stop();
	mediaRelay = null;
	activeCapture = null;

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

/**
 * Wire fatal-error handlers on Chromium and the capture stream.
 * FFmpeg failures are retried in `ffmpeg.ts`.
 */
function watchCapture(stream: Readable): void {
	activeCapture = stream;
	// If the browser is disconnected unexpectedly, exit the process
	browser?.on("disconnected", () => {
		void exitPipeline(1, "Browser disconnected unexpectedly");
	});

	// If the capture stream errors, exit — except EPIPE, which means FFmpeg's stdin closed
	stream.on("error", (err: NodeJS.ErrnoException) => {
		// Ignore errors caused by intentionally replacing the browser capture during reload.
		if (reloadingPage || stream !== activeCapture) {
			return;
		}
		if (err.code === "EPIPE") {
			return;
		}
		void exitPipeline(1, "Capture stream error", err);
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

		// If the scrollbars are hidden, hide them on the page
		if (config.hideScrollbars) {
			await hideScrollbarsOnPage(page);
		}

		// Navigate to the target URL
		if (config.embedAsMedia) {
			log(
				`Loading ${config.embedAsMedia} stream from ${config.targetUrl} (waitUntil: ${config.navigation.waitUntil}, timeout: ${config.navigation.timeoutMs}ms)...`,
			);
			await loadMediaStreamTarget(page, config.targetUrl, config.embedAsMedia, config.navigation);
		} else {
			log(
				`Navigating to ${config.targetUrl} (waitUntil: ${config.navigation.waitUntil}, timeout: ${config.navigation.timeoutMs}ms)...`,
			);
			await navigateToTarget(page, config.targetUrl, config.navigation);
		}

		// If a click play target is configured, click it
		if (config.clickPlayTarget) {
			log(`Clicking play target ${config.clickPlayTarget}...`);
			await clickPlayTarget(page, config.clickPlayTarget);
		}

		// Kick any existing media that was already on the page when navigation finished
		await kickExistingMedia(page);

		// A fresh stream is required for every FFmpeg process because a restarted
		// FFmpeg cannot parse a WebM stream from the middle of the old capture.
		const createCaptureStream = async (): Promise<Readable> => {
			// getStream() returns a Node readable stream of WebM chunks from the page.
			// frameSize is milliseconds per packet (inverse of frame rate).
			// MediaRecorder wants bits/s; config is Mbit/s video and kbit/s audio.
			const stream = await getStream(page, {
				audio: config.stream.audio,
				video: config.stream.video,
				frameSize: Math.round(1000 / config.frameRate),
				// If video is enabled, set the mime type and video bits per second
				...(config.stream.video
					? {
							mimeType: config.stream.mimeType,
							videoBitsPerSecond: Math.round(config.stream.videoMbitsPerSecond * 1_000_000),
						}
					: {}),

				// If audio is enabled, set the audio bits per second
				...(config.stream.audio
					? { audioBitsPerSecond: Math.round(config.stream.audioKbitsPerSecond * 1_000) }
					: {}),
			});

			log("Browser capture initialized.");
			return stream as Readable;
		};

		// Replace the page while the relay displays its generated loading stream.
		reloadPage = async (): Promise<void> => {
			if (reloadingPage) {
				throw new Error("page reload already in progress");
			}
			reloadingPage = true;
			try {
				if (!mediaRelay) {
					throw new Error("media relay is not initialized");
				}
				await mediaRelay.switchToFallback();
				if (config.embedAsMedia) {
					await loadMediaStreamTarget(page, config.targetUrl, config.embedAsMedia, config.navigation);
				} else {
					await navigateToTarget(page, config.targetUrl, config.navigation);
				}
				if (config.clickPlayTarget) {
					await clickPlayTarget(page, config.clickPlayTarget);
				}
				await kickExistingMedia(page);
				await mediaRelay.replaceBrowserCapture(await createCaptureStream());
			} finally {
				reloadingPage = false;
			}
		};

		log("Connecting to persistent FFmpeg relay...");
		mediaRelay = new PersistentFFmpegRelay(config, {
			isShuttingDown: () => shuttingDown,
			watchCapture,
			createCaptureStream,
		});
		await mediaRelay.start(await createCaptureStream());

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

//
// Main entry point
//
// Load the configuration and start the streaming process on startup
log(`Runtime: ${runtimeName}`);
log(`Loading config from ${process.env.CONFIG_PATH ?? `${process.cwd()}/config.json`}...`);
const config = await loadConfig();
const adminPassword = await resolveAdminPassword(config.auth.admin_password);
if (adminPassword.source === "generated") {
	log(`Generated admin password: ${adminPassword.password}`);
}
controlServer = await startControlServer(config.control, adminPassword.password, {
	reload: async () => {
		if (!reloadPage) {
			throw new Error("browser page is not ready");
		}
		await reloadPage();
	},
});
const captureRates = [
	`${config.stream.videoMbitsPerSecond} Mbps video`,
	...(config.stream.audio ? [`${config.stream.audioKbitsPerSecond} kbps audio`] : []),
].join(", ");
log(
	`Output: ${config.outputUrl} | video: ${config.ffmpeg.videoCodec} | format: ${config.ffmpeg.format} | capture: ${captureRates}`,
);
await startStreaming(config);
