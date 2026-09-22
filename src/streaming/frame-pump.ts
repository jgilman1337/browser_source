/**
 * Paces one continuous rawvideo + PCM feed into the compositor.
 * Loading frames stay on the output while browser frames accumulate, then the
 * pump switches to that cache without reopening the output URL.
 */
import { Writable } from "node:stream";

/** Bytes of one yuv420p frame. */
export function yuv420pFrameBytes(width: number, height: number): number {
	return Math.ceil((width * height * 3) / 2);
}

/** PCM bytes that match one video frame at 48 kHz stereo s16. */
export function pcmBytesPerFrame(frameRate: number): number {
	return Math.round((48_000 / frameRate) * 2 * 2);
}

/** Limited-range black so the output is not bright green before the first loading frame. */
export function blackYuv420p(width: number, height: number): Buffer {
	const ySize = width * height;
	const frame = Buffer.alloc(ySize + ySize / 2);
	frame.fill(16, 0, ySize);
	frame.fill(128, ySize);
	return frame;
}

/** Writes output-rate frames, repeating the 5 fps loading picture until the browser cache is selected. */
export class OutputFramePump {
	private readonly frameBytes: number;
	private readonly audioBytes: number;
	private readonly black: Buffer;
	private readonly silence: Buffer;
	private videoOut: Writable | null = null;
	private audioOut: Writable | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private mode: "loading" | "browser" = "loading";
	private loadingFrame: Buffer | null = null;
	private loadingPartial = Buffer.alloc(0);
	private browserFrames: Buffer[] = [];
	private browserPartial = Buffer.alloc(0);
	private browserAudio = Buffer.alloc(0);
	private lastBrowserFrame: Buffer | null = null;
	/** Called when the browser queue drops so the decoder can resume. */
	public onBelowHighWater: (() => void) | null = null;

	/** Size frames for the configured raster and output rate. */
	public constructor(
		private readonly width: number,
		private readonly height: number,
		private readonly frameRate: number,
	) {
		this.frameBytes = yuv420pFrameBytes(width, height);
		this.audioBytes = pcmBytesPerFrame(frameRate);
		this.black = blackYuv420p(width, height);
		this.silence = Buffer.alloc(this.audioBytes);
	}

	/** How many browser-video bytes are waiting to be sent. */
	public bufferedVideoBytes(): number {
		return this.browserFrames.length * this.frameBytes;
	}

	/** Attach the compositor pipes and start pacing at the output frame rate. */
	public start(videoOut: Writable, audioOut: Writable): void {
		this.videoOut = videoOut;
		this.audioOut = audioOut;
		if (this.timer) {
			return;
		}
		this.timer = setInterval(() => {
			this.tick();
		}, 1000 / this.frameRate);
	}

	/** Stop pacing. The compositor process owns closing the pipes. */
	public stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.videoOut = null;
		this.audioOut = null;
	}

	/** Show the loading animation (browser frames keep accumulating). */
	public showLoading(): void {
		this.mode = "loading";
	}

	/** Send the prefilled browser cache, then live frames. */
	public showBrowser(): void {
		this.mode = "browser";
	}

	/** Drop queued tab frames after a reload. */
	public clearBrowser(): void {
		this.browserFrames = [];
		this.browserPartial = Buffer.alloc(0);
		this.browserAudio = Buffer.alloc(0);
		this.lastBrowserFrame = null;
	}

	/** Ingest raw frames from the 5 fps loading generator. */
	public pushLoading(chunk: Buffer): void {
		this.loadingPartial = Buffer.concat([this.loadingPartial, chunk]);
		while (this.loadingPartial.length >= this.frameBytes) {
			this.loadingFrame = Buffer.from(this.loadingPartial.subarray(0, this.frameBytes));
			this.loadingPartial = this.loadingPartial.subarray(this.frameBytes);
		}
	}

	/** Ingest raw frames from the browser decoder. */
	public pushBrowserVideo(chunk: Buffer): void {
		this.browserPartial = Buffer.concat([this.browserPartial, chunk]);
		while (this.browserPartial.length >= this.frameBytes) {
			this.browserFrames.push(Buffer.from(this.browserPartial.subarray(0, this.frameBytes)));
			this.browserPartial = this.browserPartial.subarray(this.frameBytes);
		}
	}

	/** Ingest PCM from the browser decoder. */
	public pushBrowserAudio(chunk: Buffer): void {
		this.browserAudio = Buffer.concat([this.browserAudio, chunk]);
	}

	/** One output tick: loading picture, or the next cached browser frame. */
	private tick(): void {
		if (!this.videoOut || !this.audioOut) {
			return;
		}
		const video = this.nextVideo();
		const audio = this.nextAudio();
		this.videoOut.write(video);
		this.audioOut.write(audio);
	}

	/** Pick the frame that should be on the output this tick. */
	private nextVideo(): Buffer {
		if (this.mode === "browser" && this.browserFrames.length > 0) {
			const frame = this.browserFrames.shift() ?? this.black;
			this.lastBrowserFrame = frame;
			if (this.browserFrames.length < 8) {
				this.onBelowHighWater?.();
			}
			return frame;
		}
		if (this.mode === "browser" && this.lastBrowserFrame) {
			return this.lastBrowserFrame;
		}
		return this.loadingFrame ?? this.black;
	}

	/** PCM aligned to this video tick. Loading uses silence. */
	private nextAudio(): Buffer {
		if (this.mode !== "browser" || this.browserAudio.length < this.audioBytes) {
			return this.silence;
		}
		const audio = this.browserAudio.subarray(0, this.audioBytes);
		this.browserAudio = this.browserAudio.subarray(this.audioBytes);
		return audio;
	}
}
