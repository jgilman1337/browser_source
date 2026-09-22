/**
 * FFmpeg command lines for the capture pipeline.
 * Codec choices and encoder profiles live in ffmpeg-config.ts.
 */
import { readdirSync } from "node:fs";

import type { StreamerConfig } from "@/config";
import { encoderProfile, muxerArgs, type EncoderProfile } from "@/streaming/ffmpeg-config";
import { scanoutVideoFilter } from "@/streaming/scanout";

/** Keep audio on the same clock as the video. */
const LIVE_AUDIO_FILTER = "aresample=async=1";

function buildVideoFilter(profile: EncoderProfile, frameRate: number): string {
	//const base = `fps=${frameRate},format=yuv420p,gradfun=strength=1.2:radius=12`;
	const base = `fps=${frameRate},format=yuv420p`;
	if (profile.videoFilter) {
		return `${base},${profile.videoFilter}`;
	}
	return base;
}

/** Video encoder flags. The compositor and the fallback card both use this list. */
export function videoEncoderArgs(config: StreamerConfig): string[] {
	const profile = encoderProfile(config.ffmpeg.videoCodec);
	return ["-c:v", config.ffmpeg.videoCodec, ...profile.args, ...config.ffmpeg.extraArgs];
}
function loggingArgs(config: StreamerConfig): string[] {
	const { ffmpeg } = config;
	const args: string[] = [];
	if (ffmpeg.hideBanner) {
		args.push("-hide_banner");
	}
	args.push("-loglevel", ffmpeg.logLevel);
	if (ffmpeg.stats) {
		args.push("-stats", "-stats_period", String(ffmpeg.statsPeriod));
	} else {
		args.push("-nostats");
	}
	return args;
}

/**
 * Build FFmpeg CLI args for WebM stdin → encoded output (SRT, RTMP, file, etc.).
 * WebM VP8/VP9 must be re-encoded; stream copy to MPEG-TS yields audio-only output.
 */
export function buildFFmpegArgs(config: StreamerConfig): string[] {
	const { ffmpeg, outputUrl, frameRate } = config;
	if (!outputUrl) {
		throw new Error("outputUrl is missing — set outputUrl in config.json");
	}
	const profile = encoderProfile(ffmpeg.videoCodec);
	const args = loggingArgs(config);
	if (profile.preInputArgs?.length) {
		args.push(...profile.preInputArgs);
	}
	args.push("-i", "pipe:0", "-vf", buildVideoFilter(profile, frameRate));
	args.push("-c:v", ffmpeg.videoCodec, ...profile.args);
	if (ffmpeg.extraArgs.length) {
		args.push(...ffmpeg.extraArgs);
	}
	args.push("-c:a", ffmpeg.audioCodec, ...muxerArgs(ffmpeg.format), "-f", ffmpeg.format, outputUrl);
	return args;
}

/** Build the long-lived compositor command used during browser reloads. */
export function buildPersistentFFmpegArgs(config: StreamerConfig): string[] {
	const { ffmpeg, frameRate } = config;
	const profile = encoderProfile(ffmpeg.videoCodec);
	const args = loggingArgs(config);
	if (profile.preInputArgs?.length) {
		args.push(...profile.preInputArgs);
	}
	const { width, height } = config;
	const vf = buildVideoFilter(profile, frameRate);
	// One paced raw feed. The frame pump swaps loading vs browser without a new SRT dial.
	args.push(
		"-fflags",
		"+genpts",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"yuv420p",
		"-video_size",
		`${width}x${height}`,
		"-framerate",
		String(frameRate),
		"-i",
		"pipe:3",
		"-f",
		"s16le",
		"-ar",
		"48000",
		"-ac",
		"2",
		"-i",
		"pipe:4",
		"-map",
		"0:v:0",
		"-vf",
		vf,
		"-map",
		"1:a:0",
		"-af",
		LIVE_AUDIO_FILTER,
	);
	args.push(...videoEncoderArgs(config));
	args.push("-c:a", ffmpeg.audioCodec, ...muxerArgs(ffmpeg.format), "-f", ffmpeg.format, config.outputUrl);
	return args;
}

/** Render node that belongs to the same GPU as a DRM card device. */
function renderNodeFor(device: string): string | null {
	const card = device.slice(device.lastIndexOf("/") + 1);
	try {
		const render = readdirSync(`/sys/class/drm/${card}/device/drm`).find((name) => name.startsWith("renderD"));
		return render ? `/dev/dri/${render}` : null;
	} catch {
		return null;
	}
}

/**
 * Compositor args when video is a GPU scanout and tab audio arrives as PCM NUT on pipe 3.
 * The plane stays on the GPU until a hardware encoder imports it.
 */
export function buildScanoutFFmpegArgs(config: StreamerConfig, device: string): string[] {
	const { ffmpeg, frameRate, width, height } = config;
	const videoCodec = ffmpeg.videoCodec;
	const profile = encoderProfile(videoCodec);
	const filter = scanoutVideoFilter(videoCodec, width, height);
	if (!filter) {
		throw new Error(`${videoCodec} cannot import a GPU scanout`);
	}
	const args = loggingArgs(config);
	if (videoCodec.endsWith("_vaapi")) {
		args.push("-vaapi_device", renderNodeFor(device) ?? process.env.VAAPI_DEVICE ?? "/dev/dri/renderD128");
	} else if (profile.preInputArgs?.length) {
		args.push(...profile.preInputArgs);
	}
	args.push(
		"-thread_queue_size",
		"8",
		"-f",
		"kmsgrab",
		"-device",
		device,
		"-framerate",
		String(frameRate),
		"-i",
		"-",
	);
	if (config.stream.audio) {
		args.push("-thread_queue_size", "512", "-fflags", "+genpts", "-f", "nut", "-i", "pipe:3");
	} else {
		args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
	}
	args.push("-map", "0:v:0", "-vf", filter, "-map", "1:a:0", "-af", LIVE_AUDIO_FILTER);
	args.push("-c:v", videoCodec, ...profile.args);
	if (ffmpeg.extraArgs.length) {
		args.push(...ffmpeg.extraArgs);
	}
	args.push("-c:a", ffmpeg.audioCodec, ...muxerArgs(ffmpeg.format), "-f", ffmpeg.format, config.outputUrl);
	return args;
}
