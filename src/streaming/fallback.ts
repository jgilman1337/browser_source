/**
 * Process 3 of 3: loading card.
 *
 * Runs for the whole session. Encodes the card with the same video codec and
 * encoder flags as the compositor (NVENC when that is the configured codec),
 * and also writes raw frames so the compositor can send them without a second SRT dial.
 */
import { spawn, type ChildProcess } from "node:child_process";

import type { StreamerConfig } from "@/config";
import { encoderProfile } from "@/streaming/ffmpeg-config";
import { videoEncoderArgs } from "@/streaming/ffmpeg-args";

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

/** Same `-c:v` and encoder flags as the compositor, plus a raw frame tap on stdout. */
export function buildFallbackArgs(config: StreamerConfig): string[] {
	const { width, height, ffmpeg } = config;
	const profile = encoderProfile(ffmpeg.videoCodec);
	const font = "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf";
	const titleSize = Math.max(24, Math.round(height / 18));
	const ellipsis = [1, 2, 3].map((dots, step) => loadingEllipsis(font, titleSize, dots, step, 3)).join(",");
	const draw = `${ellipsis},format=yuv420p`;
	const split = profile.videoFilter
		? `[0:v]${draw}[card];[card]split[raw][forenc];[forenc]${profile.videoFilter}[enc]`
		: `[0:v]${draw}[card];[card]split[raw][enc]`;
	const args: string[] = ["-hide_banner", "-loglevel", "warning", "-nostats"];
	if (profile.preInputArgs?.length) {
		args.push(...profile.preInputArgs);
	}
	args.push(
		"-re",
		"-f",
		"lavfi",
		"-i",
		`color=c=black:s=${width}x${height}:r=${FALLBACK_FPS}`,
		"-filter_complex",
		split,
		"-map",
		"[enc]",
		...videoEncoderArgs(config),
		"-f",
		"null",
		"-",
		"-map",
		"[raw]",
		"-c:v",
		"rawvideo",
		"-f",
		"rawvideo",
		"pipe:1",
	);
	return args;
}
