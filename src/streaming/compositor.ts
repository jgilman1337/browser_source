/**
 * Process 1 of 3: compositor.
 *
 * The only process that opens the output URL. It NVENC-encodes (or uses the
 * configured video codec) paced raw frames and sends them. It does not decode
 * the browser and it does not draw the loading card.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

import type { StreamerConfig } from "@/config";
import { buildPersistentFFmpegArgs, buildScanoutFFmpegArgs } from "@/streaming/ffmpeg-args";

export type CompositorPipes = {
	video: Writable | null;
	audio: Writable | null;
};

/** Long-lived NVENC sender. Replacement happens only when the output itself drops. */
export class Compositor {
	private process: ChildProcess | null = null;
	private pipes: CompositorPipes = { video: null, audio: null };

	/** Create the sender for one output URL. */
	public constructor(
		private readonly config: StreamerConfig,
		private readonly onStderr: (line: string) => void,
		private readonly onExit: (code: number | null) => void,
	) {}

	/** True while the sender process is running. */
	public get running(): boolean {
		return this.process !== null && this.process.exitCode === null && !this.process.killed;
	}

	/** Start unless the sender is already up. Returns the raw input pipes. */
	public ensure(scanoutDevice: string | null): CompositorPipes {
		if (this.running) {
			return this.pipes;
		}
		this.pipes = this.start(scanoutDevice);
		return this.pipes;
	}

	/**
	 * Start the sender.
	 * Tab capture uses raw video on fd 3 and PCM on fd 4.
	 * GPU scanout grabs the framebuffer itself and optionally reads audio on fd 3.
	 */
	public start(scanoutDevice: string | null): CompositorPipes {
		if (this.process && this.process.exitCode === null) {
			throw new Error("compositor is already running");
		}
		const pacedRaw = scanoutDevice === null;
		const needsAudioPipe = pacedRaw || this.config.stream.audio;
		const process = spawn(
			"ffmpeg",
			scanoutDevice ? buildScanoutFFmpegArgs(this.config, scanoutDevice) : buildPersistentFFmpegArgs(this.config),
			{
				stdio: pacedRaw
					? ["ignore", "pipe", "pipe", "pipe", "pipe"]
					: needsAudioPipe
						? ["ignore", "pipe", "pipe", "pipe"]
						: ["ignore", "pipe", "pipe"],
			},
		);
		this.process = process;
		const video = pacedRaw || needsAudioPipe ? (process.stdio[3] as Writable) : null;
		const audio = pacedRaw ? (process.stdio[4] as Writable) : null;
		for (const pipe of [video, audio]) {
			pipe?.on("error", () => undefined);
		}
		process.stderr?.on("data", (data: Buffer) => {
			for (const line of data.toString().trimEnd().split("\n")) {
				if (line) {
					this.onStderr(line);
				}
			}
		});
		process.once("close", (code) => {
			if (this.process !== process) {
				return;
			}
			this.process = null;
			this.pipes = { video: null, audio: null };
			this.onExit(code);
		});
		return { video, audio };
	}

	/** Stop the sender. Used on shutdown and before an output reconnect. */
	public stop(): void {
		const process = this.process;
		this.process = null;
		this.pipes = { video: null, audio: null };
		if (process && process.exitCode === null) {
			process.kill("SIGTERM");
		}
	}
}
