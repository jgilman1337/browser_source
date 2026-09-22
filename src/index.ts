/**
 * Browser capture → FFmpeg → streaming output.
 *
 * Flow:
 *   1. Launch Chromium (headful via Xvfb in Docker)
 *   2. puppeteer-stream captures page audio/video as WebM.
 *      When this process owns a GPU scanout, video is that plane and only audio is WebM.
 *   3. FFmpeg encodes and pushes to outputUrl (SRT, RTMP, file, etc.)
 *   4. If FFmpeg dies (drop, timeout, connection refused), it is respawned
 *      indefinitely, waiting `ffmpeg.retryAfter` seconds between attempts.
 *      Chromium stays up so a listener restart does not reload the page.
 *
 * Config is read from config.json — see config.example.json.
 */
import { PassThrough, type Readable } from "node:stream";
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
import { markPageStarted } from "@/platform/uptime";
import { startControlServer, stopControlServer } from "@/http/server";
import { PersistentFFmpegRelay } from "@/streaming/relay";
import { scanoutProducesFrames, scanoutVideoFilter } from "@/streaming/scanout";

/**
 * Use the DRM device from the entrypoint when kmsgrab can already read it.
 * Otherwise video stays on the MediaRecorder WebM path.
 */
async function resolveScanoutDevice(config: StreamerConfig): Promise<string | null> {
	const requested = process.env.GPU_SCANOUT_DEVICE;
	if (!config.stream.video || !requested) {
		log("Video capture: tab capture (no GPU framebuffer)");
		return null;
	}
	if (!scanoutVideoFilter(config.ffmpeg.videoCodec, config.width, config.height)) {
		log(`Video capture: tab capture (${config.ffmpeg.videoCodec} cannot import a GPU framebuffer)`);
		return null;
	}
	if (!(await scanoutProducesFrames(requested))) {
		log(`Video capture: tab capture (GPU framebuffer ${requested} produced no frames)`);
		return null;
	}
	log(`Video capture: GPU framebuffer ${requested}`);
	return requested;
}

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
let reloadPage: ((next?: { url?: string; clickPlayTarget?: string }) => Promise<void>) | null = null;
/** Timer for proactive page and browser-capture refreshes. */
let automaticReloadTimer: ReturnType<typeof setTimeout> | null = null;

/** Tear down FFmpeg, Chromium, and puppeteer-stream's internal WebSocket server. */
async function shutdown(): Promise<void> {
	// Stop accepting administrative requests before tearing down the pipeline.
	await stopControlServer(controlServer);
	controlServer = null;
	await mediaRelay?.stop();
	mediaRelay = null;
	activeCapture = null;
	if (automaticReloadTimer) {
		clearTimeout(automaticReloadTimer);
		automaticReloadTimer = null;
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

/** Schedule the next proactive page refresh so long-lived audio capture is recreated periodically. */
function scheduleAutomaticReload(config: StreamerConfig): void {
	if (shuttingDown || !reloadPage || config.navigation.reloadAfterHours === 0) {
		return;
	}

	const delayMs = config.navigation.reloadAfterHours * 60 * 60 * 1000;
	automaticReloadTimer = setTimeout(() => {
		automaticReloadTimer = null;
		if (shuttingDown || !reloadPage) {
			return;
		}
		log(`Refreshing browser page and audio capture after ${config.navigation.reloadAfterHours} hours...`);
		void reloadPage()
			.then(() => {
				log("Automatic browser refresh completed.");
			})
			.catch((err: unknown) => {
				error("Automatic browser refresh failed; keeping the current stream", err);
			})
			.finally(() => {
				scheduleAutomaticReload(config);
			});
	}, delayMs);
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
		const scanoutDevice = await resolveScanoutDevice(config);
		log("Launching browser...");

		// launch() from puppeteer-stream loads the browser extension required for capture.
		// executablePath() is async in Puppeteer 24+ — must be awaited or launch sees "[object Promise]".
		const executablePath = await puppeteer.executablePath();
		log(`Using Chromium at ${executablePath}`);
		const launched = await launch({
			executablePath,
			headless: config.puppeteer.headless,
			args: [
				...AUTOPLAY_LAUNCH_ARGS,
				...(scanoutDevice
					? [
							"--kiosk",
							"--start-fullscreen",
							"--window-position=0,0",
							`--window-size=${config.width},${config.height}`,
						]
					: []),
				...config.puppeteer.args,
			],
			defaultViewport: scanoutDevice
				? null
				: {
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

		// A fresh stream is required for every FFmpeg process because a restarted
		// FFmpeg cannot parse a WebM stream from the middle of the old capture.
		const createCaptureStream = async (): Promise<Readable> => {
			if (scanoutDevice && !config.stream.audio) {
				return new PassThrough();
			}
			// getStream() returns a Node readable stream of WebM chunks from the page.
			// frameSize is milliseconds per packet (inverse of frame rate).
			// MediaRecorder wants bits/s; config is Mbit/s video and kbit/s audio.
			const captureVideo = config.stream.video && !scanoutDevice;
			const stream = await getStream(page, {
				audio: config.stream.audio,
				video: captureVideo,
				frameSize: Math.round(1000 / config.frameRate),
				// If video is enabled, set the mime type and video bits per second
				...(captureVideo
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
		type PageTarget = { url: string; clickPlayTarget?: string };
		let currentTarget: PageTarget = { url: config.targetUrl, clickPlayTarget: config.clickPlayTarget };

		/** Load a URL, click its play control if set, and attach a fresh capture. */
		const openAndCapture = async (target: PageTarget): Promise<void> => {
			if (!mediaRelay) {
				throw new Error("media relay is not initialized");
			}
			const isOriginalTarget = target.url === config.targetUrl;
			if (isOriginalTarget && config.embedAsMedia) {
				await loadMediaStreamTarget(page, target.url, config.embedAsMedia, config.navigation);
			} else {
				log(
					`Navigating to ${target.url} (waitUntil: ${config.navigation.waitUntil}, timeout: ${config.navigation.timeoutMs}ms)...`,
				);
				await navigateToTarget(page, target.url, config.navigation);
			}
			if (target.clickPlayTarget) {
				log(`Clicking play target ${target.clickPlayTarget}...`);
				await clickPlayTarget(page, target.clickPlayTarget, config.navigation);
			}
			await kickExistingMedia(page);
			await mediaRelay.replaceBrowserCapture(await createCaptureStream());
			markPageStarted();
		};

		reloadPage = async (next?: { url?: string; clickPlayTarget?: string }): Promise<void> => {
			if (reloadingPage) {
				throw new Error("page reload already in progress");
			}
			reloadingPage = true;
			const previousTarget = currentTarget;
			try {
				if (!mediaRelay) {
					throw new Error("media relay is not initialized");
				}
				if (next?.url) {
					currentTarget = { url: next.url, clickPlayTarget: next.clickPlayTarget };
				}
				await mediaRelay.switchToFallback();
				try {
					await openAndCapture(currentTarget);
				} catch (err) {
					error(`Page load failed, returning to ${previousTarget.url}`, err);
					currentTarget = previousTarget;
					try {
						await openAndCapture(currentTarget);
					} catch (restoreError) {
						error("Failed to restore the previous page", restoreError);
						throw restoreError;
					}
					const reason = err instanceof Error ? err.message : String(err);
					throw new Error(`${reason}; restored previous page`, { cause: err });
				}
			} finally {
				reloadingPage = false;
			}
		};

		log("Connecting to persistent FFmpeg relay...");
		mediaRelay = new PersistentFFmpegRelay(config, {
			isShuttingDown: () => shuttingDown,
			watchCapture,
			createCaptureStream,
			scanoutDevice,
		});
		if (!scanoutDevice) {
			await mediaRelay.beginWithFallback();
		}

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

		if (config.clickPlayTarget) {
			log(`Clicking play target ${config.clickPlayTarget}...`);
			await clickPlayTarget(page, config.clickPlayTarget, config.navigation);
		}

		await kickExistingMedia(page);

		await mediaRelay.start(await createCaptureStream());
		markPageStarted();
		scheduleAutomaticReload(config);

		log(`Streaming live to ${config.outputUrl}...`);
	} catch (err) {
		await exitPipeline(1, "Streaming error", err);
	}
}

// A dropped output closes FFmpeg's stdin while a paced write is in flight.
// That EPIPE must not kill the process; the relay reconnects the sender.
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE" || err.code === "ECONNRESET") {
		log("Ignored broken pipe while the output reconnects");
		return;
	}
	void exitPipeline(1, "Uncaught exception", err);
});

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
	navigate: async (request) => {
		if (!reloadPage) {
			throw new Error("browser page is not ready");
		}
		await reloadPage({ url: request.newUrl, clickPlayTarget: request.clickPlayTarget });
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
