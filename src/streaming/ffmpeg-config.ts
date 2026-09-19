import { z } from "zod";

import type { StreamerConfig } from "../config";

/** FFmpeg video encoders supported by this app (validated at config load). */
export const SUPPORTED_VIDEO_CODECS = [
	// CPU
	"libx264",
	"libx265",
	// NVIDIA NVENC
	"h264_nvenc",
	"hevc_nvenc",
	// Intel / AMD VAAPI (Linux)
	"h264_vaapi",
	"hevc_vaapi",
	"mjpeg_vaapi",
	"mpeg2_vaapi",
	"vp8_vaapi",
	"vp9_vaapi",
	"av1_vaapi",
	// Intel Quick Sync Video
	"h264_qsv",
	"hevc_qsv",
	"mjpeg_qsv",
	"mpeg2_qsv",
	"vp9_qsv",
	// AMD AMF (Windows / some FFmpeg builds)
	"h264_amf",
	"hevc_amf",
	"av1_amf",
	// V4L2 mem2mem (e.g. Raspberry Pi)
	"h264_v4l2m2m",
	"hevc_v4l2m2m",
	"h263_v4l2m2m",
	"mpeg4_v4l2m2m",
	"vp8_v4l2m2m",
] as const;

export type VideoCodec = (typeof SUPPORTED_VIDEO_CODECS)[number];

export function supportedEnum<const T extends readonly string[]>(values: T, field: string) {
	return z.enum(values, {
		error: (issue) => `Unsupported ${field}: ${JSON.stringify(issue.input)}. Supported: ${values.join(", ")}`,
	});
}

/** Output muxers allowed in config — must match the target protocol/container. */
export const SUPPORTED_OUTPUT_FORMATS = ["mpegts", "flv", "mp4", "matroska", "mov", "nut"] as const;

export type OutputFormat = (typeof SUPPORTED_OUTPUT_FORMATS)[number];

/** Audio encoders allowed in config. */
export const SUPPORTED_AUDIO_CODECS = ["aac", "libopus", "libmp3lame", "ac3"] as const;

export type AudioCodec = (typeof SUPPORTED_AUDIO_CODECS)[number];

/** FFmpeg `-loglevel` names allowed in config. */
export const SUPPORTED_LOG_LEVELS = [
	"quiet",
	"panic",
	"fatal",
	"error",
	"warning",
	"info",
	"verbose",
	"debug",
	"trace",
] as const;

export type LogLevel = (typeof SUPPORTED_LOG_LEVELS)[number];

/** FFmpeg block in config.json — codecs, muxer, logging, and reconnect. */
export const ffmpegSchema = z.object({
	videoCodec: supportedEnum(SUPPORTED_VIDEO_CODECS, "ffmpeg.videoCodec"),
	audioCodec: supportedEnum(SUPPORTED_AUDIO_CODECS, "ffmpeg.audioCodec"),
	format: supportedEnum(SUPPORTED_OUTPUT_FORMATS, "ffmpeg.format"),
	extraArgs: z.array(z.string()).default([]),
	hideBanner: z.boolean(),
	logLevel: supportedEnum(SUPPORTED_LOG_LEVELS, "ffmpeg.logLevel"),
	stats: z.boolean(),
	statsPeriod: z.number().positive("must be a positive number of seconds"),
	/** Extra FFmpeg launches after a failed process (drop, timeout, connection refused). `0` = no retry. */
	retries: z.number().int().min(0, "ffmpeg.retries must be a non-negative integer."),
	/** Seconds to wait before each FFmpeg retry. */
	retryAfter: z.number().min(0, "ffmpeg.retryAfter must be a non-negative number of seconds."),
});

export type FFmpegConfig = z.infer<typeof ffmpegSchema>;

/** Fail fast when config references an unsupported FFmpeg codec, muxer, or log option. */
export function parseFfmpegConfig(value: unknown): FFmpegConfig {
	const result = ffmpegSchema.safeParse(value);
	if (!result.success) {
		throw new Error(`Invalid ffmpeg config:\n${z.prettifyError(result.error)}`);
	}
	return result.data;
}

type EncoderProfile = {
	/** Flags placed before `-i` (hw device init, VAAPI device path, etc.). */
	preInputArgs?: string[];
	/** Video filter chain applied after demux (hwupload for GPU encoders). */
	videoFilter?: string;
	/** Encoder-specific flags placed after `-c:v`. */
	args: string[];
};

const NVENC_PROFILE: EncoderProfile = {
	args: ["-preset", "p4", "-tune", "hq", "-spatial_aq", "1", "-temporal_aq", "1"],
};

const QSV_HW: Omit<EncoderProfile, "args"> = {
	preInputArgs: ["-init_hw_device", "qsv=hw", "-filter_hw_device", "hw"],
	videoFilter: "format=nv12,hwupload=extra_hw_frames=64",
};

const QSV_LOW_LATENCY: EncoderProfile = {
	...QSV_HW,
	args: ["-preset", "veryfast", "-look_ahead", "0"],
};

const AMF_LOW_LATENCY: EncoderProfile = {
	args: ["-quality", "speed", "-usage", "lowlatency", "-rc", "cbr"],
};

function vaapiProfile(qp = "24"): EncoderProfile {
	return {
		preInputArgs: ["-vaapi_device", process.env.VAAPI_DEVICE ?? "/dev/dri/renderD128"],
		videoFilter: "format=nv12,hwupload",
		args: ["-qp", qp],
	};
}

const V4L2_PROFILE: EncoderProfile = { args: [] };

/** Muxer flags that keep live MPEG-TS timestamps playable in ffplay/VLC. */
const OUTPUT_FORMAT_ARGS: Partial<Record<OutputFormat, string[]>> = {
	mpegts: ["-max_interleave_delta", "0", "-fflags", "+genpts"],
};

function buildVideoFilter(profile: EncoderProfile, frameRate: number): string {
	const base = `fps=${frameRate},format=yuv420p,gradfun=strength=1.2:radius=12`;
	if (profile.videoFilter) {
		return `${base},${profile.videoFilter}`;
	}
	// Tab capture VP8/VP9 often has alpha + irregular fps — normalize before encode.
	return base;
}

/** Low-latency tuning per video encoder — unknown codecs are rejected at validation. */
const VIDEO_ENCODER_PROFILES: Record<VideoCodec, EncoderProfile> = {
	libx264: { args: ["-preset", "veryfast", "-tune", "zerolatency"] },
	libx265: { args: ["-preset", "veryfast", "-tune", "zerolatency"] },
	h264_nvenc: NVENC_PROFILE,
	hevc_nvenc: NVENC_PROFILE,
	h264_vaapi: vaapiProfile(),
	hevc_vaapi: vaapiProfile(),
	mjpeg_vaapi: vaapiProfile(),
	mpeg2_vaapi: vaapiProfile(),
	vp8_vaapi: vaapiProfile(),
	vp9_vaapi: vaapiProfile(),
	av1_vaapi: vaapiProfile(),
	h264_qsv: QSV_LOW_LATENCY,
	hevc_qsv: QSV_LOW_LATENCY,
	mjpeg_qsv: QSV_LOW_LATENCY,
	mpeg2_qsv: QSV_LOW_LATENCY,
	vp9_qsv: QSV_LOW_LATENCY,
	h264_amf: AMF_LOW_LATENCY,
	hevc_amf: AMF_LOW_LATENCY,
	av1_amf: AMF_LOW_LATENCY,
	h264_v4l2m2m: V4L2_PROFILE,
	hevc_v4l2m2m: V4L2_PROFILE,
	h263_v4l2m2m: V4L2_PROFILE,
	mpeg4_v4l2m2m: V4L2_PROFILE,
	vp8_v4l2m2m: V4L2_PROFILE,
};

/**
 * Build FFmpeg CLI args for WebM stdin → encoded output (SRT, RTMP, file, etc.).
 * WebM VP8/VP9 must be re-encoded; stream copy to MPEG-TS yields audio-only output.
 */
export function buildFFmpegArgs(config: StreamerConfig): string[] {
	// Validate the output URL
	const { ffmpeg, outputUrl, frameRate } = config;
	if (!outputUrl) {
		throw new Error("outputUrl is missing — set outputUrl in config.json");
	}

	// Get the video codec
	const videoCodec = ffmpeg.videoCodec;
	const profile = VIDEO_ENCODER_PROFILES[videoCodec];
	const args: string[] = [];

	// Global logging flags first so they apply to hw-device init too.
	if (ffmpeg.hideBanner) {
		args.push("-hide_banner");
	}
	args.push("-loglevel", ffmpeg.logLevel);
	if (ffmpeg.stats) {
		args.push("-stats", "-stats_period", String(ffmpeg.statsPeriod));
	} else {
		args.push("-nostats");
	}

	// Add the pre-input arguments
	if (profile.preInputArgs?.length) {
		args.push(...profile.preInputArgs);
	}

	// Video encoder + overrides, then audio — keeps `-b:v`/`-rc` on the video encoder.
	args.push("-i", "pipe:0", "-vf", buildVideoFilter(profile, frameRate));
	args.push("-c:v", videoCodec, ...profile.args);
	if (ffmpeg.extraArgs.length) {
		args.push(...ffmpeg.extraArgs);
	}
	args.push("-c:a", ffmpeg.audioCodec);

	// Add the format arguments
	const formatArgs = OUTPUT_FORMAT_ARGS[ffmpeg.format];
	if (formatArgs?.length) {
		args.push(...formatArgs);
	}

	// Add the output format and output URL
	args.push("-f", ffmpeg.format, outputUrl);
	return args;
}
