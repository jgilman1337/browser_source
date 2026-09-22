/**
 * Process 2 of 3: browser capture decoder.
 *
 * Decodes the tab capture into raw video and PCM. It does not encode and it does not
 * touch the output URL. One process per page. The next page does not start until
 * destroy() has reaped this one.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { StreamerConfig } from "@/config";

export type BrowserHandlers = {
	onVideo: (chunk: Buffer) => void;
	onAudio: (chunk: Buffer) => void;
	onStderr: (line: string) => void;
};

/** Decode one tab capture. Call destroy() before starting another page. */
export class BrowserDecoder {
	private process: ChildProcess | null = null;
	private handlers: BrowserHandlers | null = null;

	/** Create a decoder for one configured raster and frame rate. */
	public constructor(private readonly config: StreamerConfig) {}

	/** True while this page's ffmpeg is still running. */
	public get running(): boolean {
		return this.process !== null && this.process.exitCode === null && !this.process.killed;
	}

	/**
	 * Start decoding. Resolves when the first raw video byte arrives.
	 * Rejects if ffmpeg exits first.
	 */
	public start(capture: Readable, handlers: BrowserHandlers): Promise<void> {
		if (this.process) {
			throw new Error("browser decoder is already running");
		}
		this.handlers = handlers;
		const process = spawn("ffmpeg", this.args(), { stdio: ["pipe", "pipe", "pipe", "pipe"] });
		this.process = process;
		capture.pipe(process.stdin as Writable);
		process.stdout?.on("data", (chunk: Buffer) => {
			this.handlers?.onVideo(chunk);
		});
		const audio = process.stdio[3] as Readable | undefined;
		audio?.on("data", (chunk: Buffer) => {
			this.handlers?.onAudio(chunk);
		});
		process.stderr?.on("data", (data: Buffer) => {
			for (const line of data.toString().trimEnd().split("\n")) {
				if (line) {
					this.handlers?.onStderr(line);
				}
			}
		});
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const timeout = setTimeout(() => {
				if (!settled) {
					settled = true;
					reject(new Error("Timed out waiting for browser frames"));
				}
			}, 15_000);
			const finish = (): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				resolve();
			};
			process.stdout?.once("data", finish);
			process.once("close", (code) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				reject(new Error(`Browser decoder exited before producing frames (${code ?? "unknown"})`));
			});
		});
	}

	/** Hold or release the raw-video stdout. */
	public setVideoPaused(paused: boolean): void {
		const stdout = this.process?.stdout;
		if (!stdout) {
			return;
		}
		if (paused) {
			stdout.pause();
		} else {
			stdout.resume();
		}
	}

	/** SIGKILL this decoder and wait until the process is gone. Late frames are dropped. */
	public async destroy(): Promise<void> {
		const process = this.process;
		this.handlers = null;
		this.process = null;
		if (!process) {
			return;
		}
		process.stdout?.removeAllListeners("data");
		process.stderr?.removeAllListeners("data");
		const audio = process.stdio[3];
		if (audio && "removeAllListeners" in audio) {
			audio.removeAllListeners("data");
		}
		process.stdin?.destroy();
		if (process.exitCode === null && process.signalCode === null) {
			process.kill("SIGKILL");
		}
		await new Promise<void>((resolve) => {
			if (process.exitCode !== null || process.signalCode !== null) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, 2_000);
			process.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	/** Capture stdin → raw yuv420p on stdout and s16le on fd 3. */
	private args(): string[] {
		const silentAudio = this.config.stream.audio
			? []
			: ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];
		const audioMap = this.config.stream.audio ? "0:a:0" : "1:a:0";
		return [
			"-hide_banner",
			"-loglevel",
			"warning",
			"-nostats",
			"-fflags",
			"+genpts",
			"-i",
			"pipe:0",
			...silentAudio,
			"-map",
			"0:v:0",
			"-vf",
			`fps=${this.config.frameRate},format=yuv420p`,
			"-f",
			"rawvideo",
			"pipe:1",
			"-map",
			audioMap,
			"-c:a",
			"pcm_s16le",
			"-ar",
			"48000",
			"-ac",
			"2",
			"-f",
			"s16le",
			"pipe:3",
		];
	}
}
