/**
 * Persistent FFmpeg relay used to replace browser captures without closing the
 * configured downstream output.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, Writable, type Readable } from "node:stream";

import type { StreamerConfig } from "@/config";
import { error, log } from "@/platform/logger";
import { buildPersistentFFmpegArgs, buildScanoutFFmpegArgs } from "@/streaming/ffmpeg-args";

type RelayRuntime = {
	isShuttingDown: () => boolean;
	watchCapture: (stream: Readable) => void;
	createCaptureStream: () => Promise<Readable>;
	/** DRM card this process is displaying on. Null keeps MediaRecorder video. */
	scanoutDevice: string | null;
};

/** Local mux used between replaceable producers and the persistent compositor. */
const PRODUCER_NUT_ARGS = [
	"-c:v",
	"rawvideo",
	"-pix_fmt",
	"yuv420p",
	"-c:a",
	"pcm_s16le",
	"-ar",
	"48000",
	"-ac",
	"2",
	"-f",
	"nut",
	"pipe:1",
] as const;

/** Owns the downstream FFmpeg process and replaceable local media producers. */
export class PersistentFFmpegRelay {
	private readonly config: StreamerConfig;
	private readonly runtime: RelayRuntime;
	private compositor: ChildProcess | null = null;
	private browserProducer: ChildProcess | null = null;
	private fallbackProducer: ChildProcess | null = null;
	private browserCapture: Readable | null = null;
	private compositorInput: Writable | null = null;
	private mediaForwarder: PassThrough;
	private currentSource: Readable | null = null;
	private browserReady = false;
	private pipeline: Promise<void> = Promise.resolve();
	private reconnecting = false;
	private reconnectAttempt = 0;
	private wakeRetry: (() => void) | null = null;
	private outputBufferTimer: ReturnType<typeof setInterval> | null = null;
	private outputBufferReady: (() => void) | null = null;

	/** Create a persistent relay for one configured streamer. */
	public constructor(config: StreamerConfig, runtime: RelayRuntime) {
		this.config = config;
		this.runtime = runtime;
		this.mediaForwarder = createMediaForwarder(
			config.width,
			config.height,
			config.frameRate,
			config.buffer.preloadSeconds,
		);
	}

	/** Start the compositor and attach the initial browser capture. */
	public async start(capture: Readable): Promise<void> {
		await this.enqueue(async () => {
			if (this.runtime.scanoutDevice) {
				this.startCompositor();
				await this.replaceBrowserCaptureLocked(capture);
				return;
			}
			// Fill the cushion before FFmpeg exists. Its read clock would otherwise
			// start during the fill and immediately drain the buffer to catch up.
			await this.replaceBrowserCaptureLocked(capture);
			await this.waitForOutputBuffer();
			if (this.runtime.isShuttingDown()) {
				return;
			}
			this.startCompositor();
		});
	}

	/** Replace the page capture while keeping the downstream FFmpeg alive. */
	public async replaceBrowserCapture(capture: Readable): Promise<void> {
		await this.enqueue(async () => {
			const preloadSeconds = this.config.buffer.preloadSeconds;
			const pauseCompositor = preloadSeconds > 0 && !this.runtime.scanoutDevice && this.compositorInput !== null;
			if (pauseCompositor) {
				this.mediaForwarder.unpipe(this.compositorInput!);
			}
			await this.replaceBrowserCaptureLocked(capture);
			if (preloadSeconds > 0 && !this.runtime.scanoutDevice) {
				await this.waitForOutputBuffer();
				if (pauseCompositor && this.compositorInput) {
					this.mediaForwarder.pipe(this.compositorInput, { end: false });
				}
			}
		});
	}

	/** Show the generated loading still and stop the current browser capture. */
	public async switchToFallback(): Promise<void> {
		await this.enqueue(async () => {
			this.browserReady = false;
			await this.stopBrowserCapture();
			if (this.runtime.scanoutDevice && !this.config.stream.audio) {
				this.stopProcess(this.browserProducer);
				this.browserProducer = null;
				return;
			}
			const producer = this.startFallbackProducer();
			this.fallbackProducer = producer;
			this.routeProducer(producer);
			this.stopProcess(this.browserProducer);
			this.browserProducer = null;
		});
	}

	/** Close all relay children while preserving normal shutdown ordering. */
	public async stop(): Promise<void> {
		this.wakeRetry?.();
		await this.enqueue(async () => {
			this.unrouteProducer();
			this.detachCompositor();
			this.stopProcess(this.browserProducer);
			this.stopProcess(this.fallbackProducer);
			await this.stopBrowserCapture();
			this.browserProducer = null;
			this.fallbackProducer = null;
		});
	}

	/** Serialize compositor and producer swaps so reconnect cannot overlap reload. */
	private enqueue(work: () => Promise<void>): Promise<void> {
		const run = this.pipeline.then(work, work);
		this.pipeline = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Start the long-lived compositor that owns the configured output URL. */
	private startCompositor(): void {
		const scanoutDevice = this.runtime.scanoutDevice;
		const needsAudioPipe = !scanoutDevice || this.config.stream.audio;
		const process = spawn(
			"ffmpeg",
			scanoutDevice ? buildScanoutFFmpegArgs(this.config, scanoutDevice) : buildPersistentFFmpegArgs(this.config),
			{ stdio: needsAudioPipe ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] },
		);
		const stdio = process.stdio as Array<Writable | Readable | null | undefined>;
		this.compositor = process;
		if (needsAudioPipe) {
			this.compositorInput = stdio[3] as Writable;
			this.compositorInput.on("error", (pipeError: NodeJS.ErrnoException) => {
				if (!isExpectedPipeError(pipeError)) {
					error("Compositor input pipe error", pipeError);
				}
			});
			this.mediaForwarder.pipe(this.compositorInput, { end: false });
		}
		this.attachLogs(process, "compositor");
		process.once("error", (err: Error) => {
			if (process !== this.compositor || this.runtime.isShuttingDown()) {
				return;
			}
			error("FFmpeg compositor process error", err);
		});
		process.once("close", (code) => {
			if (this.runtime.isShuttingDown()) {
				return;
			}
			if (this.compositor === process) {
				this.compositor = null;
				this.compositorInput = null;
			}
			log(`Persistent FFmpeg compositor exited with code ${code ?? "unknown"}`);
			this.scheduleReconnect();
		});
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
			while (!this.runtime.isShuttingDown() && !this.compositor) {
				this.reconnectAttempt += 1;
				const retryAfter = this.config.ffmpeg.retryAfter;
				log(`Output disconnected. Reconnecting in ${retryAfter}s (attempt ${this.reconnectAttempt})...`);
				await this.sleepRetry();
				if (this.runtime.isShuttingDown()) {
					return;
				}
				await this.enqueue(async () => {
					if (this.runtime.isShuttingDown() || this.compositor) {
						return;
					}
					this.detachCompositor();
					await this.stopBrowserCapture();
					this.stopProcess(this.browserProducer);
					this.browserProducer = null;
					try {
						await this.replaceBrowserCaptureLocked(await this.runtime.createCaptureStream());
						await this.waitForOutputBuffer();
						if (!this.runtime.isShuttingDown()) {
							this.startCompositor();
						}
					} catch (err) {
						error("Failed to restore browser capture after output disconnect", err);
						this.detachCompositor();
					}
				});
				if (this.compositor) {
					this.reconnectAttempt = 0;
					log(`Streaming live to ${this.config.outputUrl}...`);
				}
			}
		} finally {
			this.reconnecting = false;
			if (!this.runtime.isShuttingDown() && !this.compositor) {
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

	/** Unblock startup once the output cushion is full and FFmpeg may start. */
	private finishOutputBuffer(): void {
		this.clearOutputBufferTimer();
		this.outputBufferReady?.();
		this.outputBufferReady = null;
	}

	/** Stop waiting to fill the output buffer. */
	private clearOutputBufferTimer(): void {
		if (this.outputBufferTimer) {
			clearInterval(this.outputBufferTimer);
			this.outputBufferTimer = null;
		}
	}

	/** Resolve when the output buffer has been handed to the compositor. */
	private waitForOutputBuffer(): Promise<void> {
		const preloadSeconds = this.config.buffer.preloadSeconds;
		if (this.runtime.scanoutDevice || preloadSeconds <= 0) {
			return Promise.resolve();
		}
		const target = outputBufferBytes(this.config.width, this.config.height, this.config.frameRate, preloadSeconds);
		const started = Date.now();
		log(`Filling ${preloadSeconds}s output buffer (${Math.round(target / 1_048_576)} MB) before sending`);
		return new Promise<void>((resolve) => {
			this.outputBufferReady = resolve;
			this.outputBufferTimer = setInterval(() => {
				const filled = this.mediaForwarder.readableLength >= target;
				const waitedMs = Date.now() - started;
				const gaveUp = waitedMs >= (preloadSeconds + 2) * 1000 && this.mediaForwarder.readableLength > 0;
				if (!filled && !gaveUp && !this.runtime.isShuttingDown()) {
					return;
				}
				if (filled || gaveUp) {
					log(`Output buffer ready, sending to ${this.config.outputUrl}`);
				}
				this.finishOutputBuffer();
			}, 50);
		});
	}

	/** Drop the current compositor so a replacement can own pipe:3. */
	private detachCompositor(): void {
		this.finishOutputBuffer();
		this.unrouteProducer();
		if (this.compositorInput) {
			this.mediaForwarder.unpipe(this.compositorInput);
		}
		this.stopProcess(this.compositor);
		this.compositor = null;
		this.compositorInput = null;
		this.mediaForwarder = createMediaForwarder(
			this.config.width,
			this.config.height,
			this.config.frameRate,
			this.config.buffer.preloadSeconds,
		);
	}

	/** Swap in a new page capture while the compositor keeps the output socket. */
	private async replaceBrowserCaptureLocked(capture: Readable): Promise<void> {
		if (this.runtime.isShuttingDown()) {
			return;
		}
		this.browserReady = false;
		await this.stopBrowserCapture();
		this.stopProcess(this.browserProducer);
		if (this.runtime.scanoutDevice && !this.config.stream.audio) {
			this.browserProducer = null;
			this.browserReady = true;
			this.stopProcess(this.fallbackProducer);
			this.fallbackProducer = null;
			return;
		}
		this.browserCapture = capture;
		this.runtime.watchCapture(capture);
		const producer = this.startBrowserProducer(capture);
		this.browserProducer = producer;
		this.routeProducer(producer);
		await this.waitForBrowserFrames(producer);
		this.stopProcess(this.fallbackProducer);
		this.fallbackProducer = null;
	}

	/** Start FFmpeg that decodes the browser WebM into one interleaved local stream. */
	private startBrowserProducer(capture: Readable): ChildProcess {
		if (this.runtime.scanoutDevice) {
			return this.startAudioProducer(capture);
		}
		const audioInput = this.config.stream.audio
			? ["-map", "0:v:0", "-map", "0:a:0"]
			: [
					"-f",
					"lavfi",
					"-i",
					"anullsrc=channel_layout=stereo:sample_rate=48000",
					"-map",
					"0:v:0",
					"-map",
					"1:a:0",
				];
		const process = spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"warning",
				"-nostats",
				"-thread_queue_size",
				"64",
				"-fflags",
				"+genpts",
				"-i",
				"pipe:0",
				"-fps_mode",
				"passthrough",
				...audioInput,
				...PRODUCER_NUT_ARGS,
				"-progress",
				"pipe:3",
			],
			{ stdio: ["pipe", "pipe", "pipe", "pipe"] },
		);
		capture.pipe(process.stdin!);
		this.attachLogs(process, "browser decoder");
		return process;
	}

	/** Decode tab audio to PCM. Video is the GPU scanout, not this stream. */
	private startAudioProducer(capture: Readable): ChildProcess {
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
				"-progress",
				"pipe:3",
			],
			{ stdio: ["pipe", "pipe", "pipe", "pipe"] },
		);
		capture.pipe(process.stdin!);
		this.attachLogs(process, "audio decoder");
		return process;
	}

	/** Start the FFmpeg-generated black loading still. */
	private startFallbackProducer(): ChildProcess {
		if (this.runtime.scanoutDevice) {
			return this.startSilentAudio();
		}
		const { width, height } = this.config;
		const font = "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf";
		const title = `drawtext=fontfile=${font}:text='Page Loading...':fontcolor=white:fontsize=${Math.max(24, Math.round(height / 18))}:x=(w-text_w)/2:y=(h-text_h)/2`;
		const process = spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"warning",
				"-nostats",
				"-re",
				"-f",
				"lavfi",
				"-i",
				`color=c=black:s=${width}x${height}:r=1`,
				"-f",
				"lavfi",
				"-i",
				"anullsrc=channel_layout=stereo:sample_rate=48000",
				"-filter_complex",
				`[0:v]${title},format=yuv420p[v]`,
				"-map",
				"[v]",
				"-map",
				"1:a",
				...PRODUCER_NUT_ARGS,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		this.attachLogs(process, "fallback generator");
		return process;
	}

	/** Keep the scanout compositor's audio input fed while the page is changing. */
	private startSilentAudio(): ChildProcess {
		const process = spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"warning",
				"-nostats",
				"-f",
				"lavfi",
				"-i",
				"anullsrc=channel_layout=stereo:sample_rate=48000",
				"-c:a",
				"pcm_s16le",
				"-f",
				"nut",
				"pipe:1",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		this.attachLogs(process, "silent audio");
		return process;
	}

	/** Wait until the browser decoder reports its first decoded frame. */
	private async waitForBrowserFrames(process: ChildProcess): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Timed out waiting for browser frames")), 15_000);
			process.stdio[3]?.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				const scanoutAudio = this.runtime.scanoutDevice !== null;
				const started = scanoutAudio ? /out_time_us=([1-9]\d*)/.test(text) : text.includes("frame=");
				if (started) {
					clearTimeout(timeout);
					this.browserReady = true;
					resolve();
				}
			});
			process.once("close", (code) => {
				clearTimeout(timeout);
				if (!this.browserReady) {
					reject(new Error(`Browser decoder exited before producing frames (${code ?? "unknown"})`));
				}
			});
		});
	}

	/** Point the compositor pipe at one producer, replacing any previous source. */
	private routeProducer(process: ChildProcess): void {
		this.unrouteProducer();
		if (process.stdout) {
			this.currentSource = process.stdout;
			process.stdout.pipe(this.mediaForwarder, { end: false });
		}
	}

	/** Detach the current producer without closing compositor stdin. */
	private unrouteProducer(): void {
		this.currentSource?.unpipe(this.mediaForwarder);
		this.currentSource = null;
	}

	/** Log child-process diagnostics without exposing credentials. */
	private attachLogs(process: ChildProcess, label: string): void {
		process.stderr?.on("data", (data: Buffer) => {
			for (const line of data.toString().trimEnd().split("\n")) {
				if (line && !isNoisyFfmpegLine(line)) {
					log(`[FFmpeg ${label}] ${line}`);
				}
			}
		});
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

	/** Terminate one child process if it is still alive. */
	private stopProcess(process: ChildProcess | null): void {
		if (process && !process.killed) {
			process.kill("SIGTERM");
		}
	}
}

/** Bytes of raw video kept so the sender can run ahead of the next captured frame. */
function outputBufferBytes(width: number, height: number, frameRate: number, preloadSeconds: number): number {
	const frameBytes = Math.ceil((width * height * 3) / 2);
	return frameBytes * Math.ceil(frameRate * preloadSeconds);
}

/** Hold the output cushion. One extra frame so the buffer can fill without stalling the decoder. */
function createMediaForwarder(width: number, height: number, frameRate: number, preloadSeconds: number): PassThrough {
	const frameBytes = Math.ceil((width * height * 3) / 2);
	const cushion = outputBufferBytes(width, height, frameRate, preloadSeconds);
	const forwarder = new PassThrough({ highWaterMark: Math.max(frameBytes, cushion + frameBytes) });
	forwarder.on("error", (err: NodeJS.ErrnoException) => {
		if (!isExpectedPipeError(err)) {
			error("Media forwarder error", err);
		}
	});
	return forwarder;
}

/** Drop per-packet timestamp warnings that flood the console after a source swap. */
function isNoisyFfmpegLine(line: string): boolean {
	return line.includes("Non-monotonic DTS") || line.includes("Last message repeated");
}

/** True when a pipe error is the expected result of FFmpeg exiting. */
function isExpectedPipeError(err: NodeJS.ErrnoException): boolean {
	return err.code === "EPIPE" || err.code === "ECONNRESET";
}
