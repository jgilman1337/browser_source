/**
 * Orchestrates the three FFmpeg processes:
 *   1. compositor.ts  — NVENC + output sender (stays up)
 *   2. browser.ts — one browser capture decoder per page (killed before the next page)
 *   3. fallback.ts    — loading card, same video encoder settings as the compositor
 *
 * This file does not build FFmpeg command lines.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";

import type { StreamerConfig } from "@/config";
import { error, log } from "@/platform/logger";
import { BrowserDecoder } from "@/streaming/browser";
import { Compositor } from "@/streaming/compositor";
import { FallbackEncoder } from "@/streaming/fallback";
import { OutputFramePump } from "@/streaming/frame-pump";

type RelayRuntime = {
	isShuttingDown: () => boolean;
	watchCapture: (stream: Readable) => void;
	createCaptureStream: () => Promise<Readable>;
	/** DRM card this process is displaying on. Null keeps MediaRecorder video. */
	scanoutDevice: string | null;
};

/** Owns process lifetime. Swap means kill the browser decoder, not the sender. */
export class PersistentFFmpegRelay {
	private readonly runtime: RelayRuntime;
	private readonly pump: OutputFramePump;
	private readonly compositor: Compositor;
	private readonly browser: BrowserDecoder;
	private readonly fallback: FallbackEncoder;
	private browserCapture: Readable | null = null;
	private scanoutAudio: ChildProcess | null = null;
	private mediaForwarder: PassThrough;
	private pipeline: Promise<void> = Promise.resolve();
	private reconnecting = false;
	private reconnectAttempt = 0;
	private wakeRetry: (() => void) | null = null;
	private outputBufferTimer: ReturnType<typeof setInterval> | null = null;
	private outputBufferReady: (() => void) | null = null;

	/** Create the three-process relay for one configured streamer. */
	public constructor(
		private readonly config: StreamerConfig,
		runtime: RelayRuntime,
	) {
		this.runtime = runtime;
		this.pump = new OutputFramePump(config.width, config.height, config.frameRate);
		this.browser = new BrowserDecoder(config);
		this.compositor = new Compositor(
			config,
			(line) => this.logFfmpeg("compositor", line),
			(code) => {
				this.pump.stop();
				if (this.runtime.isShuttingDown()) {
					return;
				}
				log(`Persistent FFmpeg compositor exited with code ${code ?? "unknown"}`);
				this.scheduleReconnect();
			},
		);
		this.fallback = new FallbackEncoder(
			config,
			(chunk) => this.pump.pushLoading(chunk),
			(line) => this.logFfmpeg("fallback", line),
			() => {
				if (!this.runtime.isShuttingDown()) {
					this.fallback.ensure();
				}
			},
		);
		this.mediaForwarder = new PassThrough();
	}

	/** Put the loading card on the output before navigation. */
	public async beginWithFallback(): Promise<void> {
		await this.enqueue(async () => {
			if (this.runtime.scanoutDevice) {
				return;
			}
			this.showLoadingOnOutput();
		});
	}

	/** Decode the first page into the cache, then swap it onto the live output. */
	public async start(capture: Readable): Promise<void> {
		await this.enqueue(async () => {
			if (this.runtime.scanoutDevice) {
				this.showLoadingOnOutput();
				await this.startScanoutAudio(capture);
				return;
			}
			this.showLoadingOnOutput();
			await this.discardBrowserDecoder();
			await this.startBrowserDecoder(capture);
			await this.waitForOutputBuffer();
			if (this.runtime.isShuttingDown()) {
				return;
			}
			this.pump.showBrowser();
			log("Switched from loading card to browser capture");
		});
	}

	/** Kill the previous browser decoder, cache the new page, then swap. */
	public async replaceBrowserCapture(capture: Readable): Promise<void> {
		await this.enqueue(async () => {
			if (this.runtime.scanoutDevice) {
				await this.startScanoutAudio(capture);
				return;
			}
			await this.discardBrowserDecoder();
			this.showLoadingOnOutput();
			await this.startBrowserDecoder(capture);
			await this.waitForOutputBuffer();
			if (this.runtime.isShuttingDown()) {
				return;
			}
			this.pump.showBrowser();
			log("Switched from loading card to browser capture");
		});
	}

	/** Drop the page decoder immediately and keep the loading card on the output. */
	public async switchToFallback(): Promise<void> {
		await this.enqueue(async () => {
			await this.stopBrowserCapture();
			if (this.runtime.scanoutDevice && !this.config.stream.audio) {
				this.stopScanoutAudio();
				return;
			}
			if (!this.runtime.scanoutDevice) {
				await this.discardBrowserDecoder();
				this.showLoadingOnOutput();
			} else {
				this.stopScanoutAudio();
			}
		});
	}

	/** Close all three processes. */
	public async stop(): Promise<void> {
		this.wakeRetry?.();
		await this.enqueue(async () => {
			await this.discardBrowserDecoder();
			await this.stopBrowserCapture();
			this.fallback.stop();
			this.pump.stop();
			this.compositor.stop();
			this.stopScanoutAudio();
		});
	}

	/** Serialize swaps so reconnect cannot overlap reload. */
	private enqueue(work: () => Promise<void>): Promise<void> {
		const run = this.pipeline.then(work, work);
		this.pipeline = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Loading card on the existing sender. Starts the sender if this is the first time. */
	private showLoadingOnOutput(): void {
		this.pump.showLoading();
		this.fallback.ensure();
		if (!this.compositor.running) {
			const pipes = this.compositor.ensure(this.runtime.scanoutDevice);
			if (pipes.video && pipes.audio) {
				this.pump.start(pipes.video, pipes.audio);
			} else if (pipes.video) {
				this.mediaForwarder.pipe(pipes.video, { end: false });
			}
		}
		log("Loading card on output");
	}

	/** SIGKILL the browser decoder and drop every frame it produced. */
	private async discardBrowserDecoder(): Promise<void> {
		this.pump.clearBrowser();
		await this.browser.destroy();
		this.pump.clearBrowser();
	}

	/** Start a new browser decoder. The previous one must already be dead. */
	private async startBrowserDecoder(capture: Readable): Promise<void> {
		if (this.runtime.isShuttingDown()) {
			return;
		}
		this.browserCapture = capture;
		this.runtime.watchCapture(capture);
		const maxBytes = outputBufferBytes(
			this.config.width,
			this.config.height,
			this.config.frameRate,
			this.config.buffer.preloadSeconds + 1,
		);
		await this.browser.start(capture, {
			onVideo: (chunk) => {
				this.pump.pushBrowserVideo(chunk);
				if (maxBytes > 0 && this.pump.bufferedVideoBytes() >= maxBytes) {
					this.browser.setVideoPaused(true);
				}
			},
			onAudio: (chunk) => {
				this.pump.pushBrowserAudio(chunk);
			},
			onStderr: (line) => this.logFfmpeg("browser", line),
		});
		this.pump.onBelowHighWater = () => {
			this.browser.setVideoPaused(false);
		};
	}

	/** Queue an output reconnect that retries until the destination accepts packets. */
	private scheduleReconnect(): void {
		if (this.reconnecting || this.runtime.isShuttingDown()) {
			return;
		}
		this.reconnecting = true;
		void this.reconnectLoop();
	}

	/** Respawn the compositor forever; sleep between attempts so reload can still run. */
	private async reconnectLoop(): Promise<void> {
		try {
			while (!this.runtime.isShuttingDown() && !this.compositor.running) {
				this.reconnectAttempt += 1;
				const retryAfter = this.config.ffmpeg.retryAfter;
				log(`Output disconnected. Reconnecting in ${retryAfter}s (attempt ${this.reconnectAttempt})...`);
				await this.sleepRetry();
				if (this.runtime.isShuttingDown()) {
					return;
				}
				await this.enqueue(async () => {
					if (this.runtime.isShuttingDown() || this.compositor.running) {
						return;
					}
					try {
						await this.discardBrowserDecoder();
						await this.stopBrowserCapture();
						this.showLoadingOnOutput();
						await this.startBrowserDecoder(await this.runtime.createCaptureStream());
						await this.waitForOutputBuffer();
						if (!this.runtime.isShuttingDown()) {
							this.pump.showBrowser();
							log("Browser capture restored on output");
						}
					} catch (err) {
						error("Failed to restore browser capture after output disconnect", err);
						this.compositor.stop();
						this.pump.stop();
					}
				});
				if (this.compositor.running) {
					this.reconnectAttempt = 0;
					log(`Streaming live to ${this.config.outputUrl}...`);
				}
			}
		} finally {
			this.reconnecting = false;
			if (!this.runtime.isShuttingDown() && !this.compositor.running) {
				this.scheduleReconnect();
			}
		}
	}

	/** Interruptible wait used between output reconnect attempts. */
	private async sleepRetry(): Promise<void> {
		const retryAfterMs = this.config.ffmpeg.retryAfter * 1000;
		if (retryAfterMs <= 0) {
			return;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (this.wakeRetry === wake) {
					this.wakeRetry = null;
				}
				resolve();
			}, retryAfterMs);
			const wake = (): void => {
				clearTimeout(timer);
				this.wakeRetry = null;
				resolve();
			};
			this.wakeRetry = wake;
		});
	}

	/** Unblock once the browser cache is full. The loading card stays on the output. */
	private finishOutputBuffer(): void {
		if (this.outputBufferTimer) {
			clearInterval(this.outputBufferTimer);
			this.outputBufferTimer = null;
		}
		this.outputBufferReady?.();
		this.outputBufferReady = null;
	}

	/** Resolve when the browser frame cache is full. */
	private waitForOutputBuffer(): Promise<void> {
		const preloadSeconds = this.config.buffer.preloadSeconds;
		if (this.runtime.scanoutDevice || preloadSeconds <= 0) {
			return Promise.resolve();
		}
		const target = outputBufferBytes(this.config.width, this.config.height, this.config.frameRate, preloadSeconds);
		const started = Date.now();
		const maxWaitMs = (preloadSeconds + 2) * 1000;
		log(`Filling ${preloadSeconds}s browser cache (${Math.round(target / 1_048_576)} MB) while loading card is on output`);
		return new Promise<void>((resolve) => {
			this.outputBufferReady = resolve;
			this.outputBufferTimer = setInterval(() => {
				const filled = this.pump.bufferedVideoBytes() >= target;
				const waitedMs = Date.now() - started;
				const timedOut = waitedMs >= maxWaitMs;
				if (!filled && !timedOut && !this.runtime.isShuttingDown()) {
					return;
				}
				if (filled) {
					log("Browser cache ready, swapping onto the live output");
				} else if (timedOut) {
					log(
						`Browser cache preload timed out after ${maxWaitMs}ms with ${this.pump.bufferedVideoBytes()} bytes (target ${target}); swapping`,
					);
				}
				this.finishOutputBuffer();
			}, 50);
		});
	}

	/** Decode tab audio when video is the GPU scanout. */
	private async startScanoutAudio(capture: Readable): Promise<void> {
		this.stopScanoutAudio();
		await this.stopBrowserCapture();
		if (!this.config.stream.audio) {
			return;
		}
		this.browserCapture = capture;
		this.runtime.watchCapture(capture);
		const process = spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"warning",
				"-nostats",
				"-fflags",
				"+genpts",
				"-i",
				"pipe:0",
				"-map",
				"0:a:0",
				"-c:a",
				"pcm_s16le",
				"-ar",
				"48000",
				"-ac",
				"2",
				"-f",
				"nut",
				"pipe:1",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		capture.pipe(process.stdin!);
		process.stderr?.on("data", (data: Buffer) => {
			for (const line of data.toString().trimEnd().split("\n")) {
				if (line) {
					this.logFfmpeg("scanout audio", line);
				}
			}
		});
		if (process.stdout) {
			process.stdout.pipe(this.mediaForwarder, { end: false });
		}
		this.scanoutAudio = process;
	}

	/** Stop the scanout audio decoder. */
	private stopScanoutAudio(): void {
		if (this.scanoutAudio && this.scanoutAudio.exitCode === null) {
			this.scanoutAudio.kill("SIGKILL");
		}
		this.scanoutAudio = null;
	}

	/** Stop the active puppeteer-stream capture before Chromium starts another one. */
	private async stopBrowserCapture(): Promise<void> {
		const capture = this.browserCapture;
		this.browserCapture = null;
		if (!capture) {
			return;
		}
		capture.unpipe();
		await new Promise<void>((resolve) => {
			let finished = false;
			const finish = (): void => {
				if (finished) {
					return;
				}
				finished = true;
				resolve();
			};
			capture.once("close", finish);
			capture.once("end", finish);
			capture.destroy();
			setTimeout(finish, 500);
		});
	}

	/** Log one child-process line without timestamp spam. */
	private logFfmpeg(label: string, line: string): void {
		if (line.includes("Non-monotonic DTS") || line.includes("Last message repeated")) {
			return;
		}
		log(`[FFmpeg ${label}] ${line}`);
	}
}

/** Bytes of raw video kept so the sender can run ahead of the next captured frame. */
function outputBufferBytes(width: number, height: number, frameRate: number, preloadSeconds: number): number {
	const frameBytes = Math.ceil((width * height * 3) / 2);
	return frameBytes * Math.ceil(frameRate * preloadSeconds);
}
