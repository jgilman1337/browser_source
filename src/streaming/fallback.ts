/**
 * Process 3 of 3: loading card.
 *
 * Draws the card and writes raw frames. The compositor is the only NVENC session
 * and is what sends those frames.
 */
import { spawn, type ChildProcess } from "node:child_process";

import type { StreamerConfig } from "@/config";

/** Card rate. The compositor repeats these frames at the output frame rate. */
export const FALLBACK_FPS = 5;

/** How long each of `.`, `..`, and `...` stays on screen. */
const ELLIPSIS_HOLD_SECONDS = 1;

/** Long-lived loading card. Restart only if this process exits unexpectedly. */
export class FallbackEncoder {
	private process: ChildProcess | null = null;

	/** Create the card encoder for one raster. */
	public constructor(
		private readonly config: StreamerConfig,
		private readonly onFrame: (chunk: Buffer) => void,
		private readonly onStderr: (line: string) => void,
		private readonly onExit: () => void,
	) {}

	/** Start unless this process is already running. */
	public ensure(): void {
		if (this.process && this.process.exitCode === null && !this.process.killed) {
			return;
		}
		const process = spawn("ffmpeg", buildFallbackArgs(this.config), { stdio: ["ignore", "pipe", "pipe"] });
		this.process = process;
		process.stdout?.on("data", (chunk: Buffer) => {
			this.onFrame(chunk);
		});
		process.stderr?.on("data", (data: Buffer) => {
			for (const line of data.toString().trimEnd().split("\n")) {
				if (line) {
					this.onStderr(line);
				}
			}
		});
		process.once("close", () => {
			if (this.process !== process) {
				return;
			}
			this.process = null;
			this.onExit();
		});
	}

	/** Stop the card. Used on shutdown. */
	public stop(): void {
		const process = this.process;
		this.process = null;
		if (process && process.exitCode === null) {
			process.kill("SIGKILL");
		}
	}
}

/** One fallback frame of "Page Loading" plus a growing ellipsis. */
function loadingEllipsis(font: string, size: number, dots: number, step: number, steps: number): string {
	const stepTest = `eq(mod(floor(t/${ELLIPSIS_HOLD_SECONDS})\\,${steps})\\,${step})`;
	return `drawtext=fontfile=${font}:text='Page Loading${".".repeat(dots)}':fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=(h-text_h)/2:enable='${stepTest}'`;
}

/** Draw the loading card. The compositor encodes it with the configured video codec. */
export function buildFallbackArgs(config: StreamerConfig): string[] {
	const { width, height } = config;
	const font = "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf";
	const titleSize = Math.max(24, Math.round(height / 18));
	const ellipsis = [1, 2, 3].map((dots, step) => loadingEllipsis(font, titleSize, dots, step, 3)).join(",");
	const draw = `${ellipsis},format=yuv420p`;
	return [
		"-hide_banner",
		"-loglevel",
		"warning",
		"-nostats",
		"-re",
		"-f",
		"lavfi",
		"-i",
		`color=c=black:s=${width}x${height}:r=${FALLBACK_FPS}`,
		"-vf",
		draw,
		"-f",
		"rawvideo",
		"pipe:1",
	];
}
