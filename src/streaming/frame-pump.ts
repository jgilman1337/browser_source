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
	private timer: ReturnType<typeof setTimeout> | null = null;
	private startedAt = 0;
	private framesSent = 0;
	private mode: "loading" | "browser" = "loading";
	private loadingFrame: Buffer | null = null;
	private loadingFill = 0;
	private readonly loadingScratch: Buffer;
	private browserFrames: Buffer[] = [];
	private browserFill = 0;
	private readonly browserScratch: Buffer;
	private audioChunks: Buffer[] = [];
	private audioQueued = 0;
	private lastBrowserFrame: Buffer | null = null;
	private lastAudio: Buffer | null = null;
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
		this.loadingScratch = Buffer.allocUnsafe(this.frameBytes);
		this.browserScratch = Buffer.allocUnsafe(this.frameBytes);
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
		this.startedAt = performance.now();
		this.framesSent = 0;
		this.schedule();
	}

	/** Stop pacing. The compositor process owns closing the pipes. */
	public stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.startedAt = 0;
		this.framesSent = 0;
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
		this.browserFill = 0;
		this.audioChunks = [];
		this.audioQueued = 0;
		this.lastBrowserFrame = null;
		this.lastAudio = null;
	}

	/** Ingest raw frames from the 5 fps loading generator. */
	public pushLoading(chunk: Buffer): void {
		this.copyFrames(chunk, this.loadingScratch, this.loadingFill, (frame, fill) => {
			this.loadingFill = fill;
			if (frame) {
				this.loadingFrame = frame;
			}
		});
	}

	/** Ingest raw frames from the browser decoder. */
	public pushBrowserVideo(chunk: Buffer): void {
		this.copyFrames(chunk, this.browserScratch, this.browserFill, (frame, fill) => {
			this.browserFill = fill;
			if (frame) {
				this.browserFrames.push(frame);
			}
		});
	}

	/** Ingest PCM from the browser decoder. */
	public pushBrowserAudio(chunk: Buffer): void {
		this.audioChunks.push(chunk);
		this.audioQueued += chunk.length;
	}

	/** Stay on the output frame grid. A late tick sends the frames it owes instead of slipping the clock. */
	private schedule(): void {
		if (!this.videoOut || !this.audioOut) {
			return;
		}
		const interval = 1000 / this.frameRate;
		const now = performance.now();
		const due = this.startedAt + this.framesSent * interval;
		if (now + 0.5 < due) {
			this.timer = setTimeout(() => this.schedule(), due - now);
			return;
		}
		let burst = 0;
		while (this.startedAt + this.framesSent * interval <= now && burst < 2) {
			this.tick();
			this.framesSent += 1;
			burst += 1;
		}
		const next = this.startedAt + this.framesSent * interval;
		this.timer = setTimeout(() => this.schedule(), Math.max(0, next - performance.now()));
	}

	/** Copy chunk bytes into a frame scratch without reallocating the partial frame. */
	private copyFrames(
		chunk: Buffer,
		scratch: Buffer,
		fill: number,
		done: (frame: Buffer | null, fill: number) => void,
	): void {
		let offset = 0;
		while (offset < chunk.length) {
			const n = Math.min(this.frameBytes - fill, chunk.length - offset);
			chunk.copy(scratch, fill, offset, offset + n);
			fill += n;
			offset += n;
			if (fill === this.frameBytes) {
				done(Buffer.from(scratch), 0);
				fill = 0;
			}
		}
		done(null, fill);
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

	/** PCM aligned to this video tick. A short gap repeats the last samples instead of inserting silence. */
	private nextAudio(): Buffer {
		if (this.mode !== "browser" || this.audioQueued < this.audioBytes) {
			return this.lastAudio ?? this.silence;
		}
		const audio = Buffer.allocUnsafe(this.audioBytes);
		let filled = 0;
		while (filled < this.audioBytes) {
			const head = this.audioChunks[0];
			if (!head) {
				break;
			}
			const n = Math.min(head.length, this.audioBytes - filled);
			head.copy(audio, filled, 0, n);
			filled += n;
			this.audioQueued -= n;
			if (n === head.length) {
				this.audioChunks.shift();
			} else {
				this.audioChunks[0] = head.subarray(n);
			}
		}
		this.lastAudio = audio;
		return audio;
	}
}
