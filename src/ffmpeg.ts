import type { StreamerConfig } from "./config.js";

export type FfmpegConfig = StreamerConfig["ffmpeg"];

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

/** Output muxers allowed in config — must match the target protocol/container. */
export const SUPPORTED_OUTPUT_FORMATS = [
	"mpegts",
	"flv",
	"mp4",
	"matroska",
	"mov",
	"nut",
] as const;

export type OutputFormat = (typeof SUPPORTED_OUTPUT_FORMATS)[number];

/** Audio encoders allowed in config. */
export const SUPPORTED_AUDIO_CODECS = ["aac", "libopus", "libmp3lame", "ac3"] as const;

export type AudioCodec = (typeof SUPPORTED_AUDIO_CODECS)[number];

type EncoderProfile = {
	/** Flags placed before `-i` (hw device init, VAAPI device path, etc.). */
	preInputArgs?: string[];
	/** Video filter chain applied after demux (hwupload for GPU encoders). */
	videoFilter?: string;
	/** Encoder-specific flags placed after `-c:v`. */
	args: string[];
};

const NVENC_LOW_LATENCY: EncoderProfile = {
	args: ["-preset", "p1", "-tune", "ull", "-zerolatency", "1"],
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
	if (profile.videoFilter) {
		return `fps=${frameRate},${profile.videoFilter}`;
	}
	// Tab capture VP8 often has alpha + irregular fps — normalize before encode.
	return `fps=${frameRate},format=yuv420p`;
}

/** Low-latency tuning per video encoder — unknown codecs are rejected at validation. */
const VIDEO_ENCODER_PROFILES: Record<VideoCodec, EncoderProfile> = {
	libx264: { args: ["-preset", "veryfast", "-tune", "zerolatency"] },
	libx265: { args: ["-preset", "veryfast", "-tune", "zerolatency"] },
	h264_nvenc: NVENC_LOW_LATENCY,
	hevc_nvenc: NVENC_LOW_LATENCY,
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

function isVideoCodec(value: string): value is VideoCodec {
	return (SUPPORTED_VIDEO_CODECS as readonly string[]).includes(value);
}

function isOutputFormat(value: string): value is OutputFormat {
	return (SUPPORTED_OUTPUT_FORMATS as readonly string[]).includes(value);
}

function isAudioCodec(value: string): value is AudioCodec {
	return (SUPPORTED_AUDIO_CODECS as readonly string[]).includes(value);
}

function formatAllowedList(values: readonly string[]): string {
	return values.join(", ");
}

/** Fail fast when config references an unsupported FFmpeg codec or muxer. */
export function validateFfmpegConfig(ffmpeg: FfmpegConfig): void {
	if (!isVideoCodec(ffmpeg.videoCodec)) {
		throw new Error(
			`Unsupported ffmpeg.videoCodec: "${ffmpeg.videoCodec}". Supported: ${formatAllowedList(SUPPORTED_VIDEO_CODECS)}`,
		);
	}

	if (!isAudioCodec(ffmpeg.audioCodec)) {
		throw new Error(
			`Unsupported ffmpeg.audioCodec: "${ffmpeg.audioCodec}". Supported: ${formatAllowedList(SUPPORTED_AUDIO_CODECS)}`,
		);
	}

	if (!isOutputFormat(ffmpeg.format)) {
		throw new Error(
			`Unsupported ffmpeg.format: "${ffmpeg.format}". Supported: ${formatAllowedList(SUPPORTED_OUTPUT_FORMATS)}`,
		);
	}
}

/**
 * Build FFmpeg CLI args for WebM stdin → encoded output (SRT, RTMP, file, etc.).
 * WebM VP8/VP9 must be re-encoded; stream copy to MPEG-TS yields audio-only output.
 */
export function buildFfmpegArgs(config: StreamerConfig): string[] {
	validateFfmpegConfig(config.ffmpeg);

	const { ffmpeg, outputUrl, frameRate } = config;
	if (!outputUrl) {
		throw new Error("outputUrl is missing — set outputUrl in config.json");
	}

	const videoCodec = ffmpeg.videoCodec as VideoCodec;
	const profile = VIDEO_ENCODER_PROFILES[videoCodec];
	const args: string[] = [];

	if (profile.preInputArgs?.length) {
		args.push(...profile.preInputArgs);
	}

	args.push("-i", "pipe:0", "-vf", buildVideoFilter(profile, frameRate));
	args.push("-c:v", videoCodec, ...profile.args);
	args.push("-c:a", ffmpeg.audioCodec);

	if (ffmpeg.extraArgs?.length) {
		args.push(...ffmpeg.extraArgs);
	}

	const formatArgs = OUTPUT_FORMAT_ARGS[ffmpeg.format as OutputFormat];
	if (formatArgs?.length) {
		args.push(...formatArgs);
	}

	args.push("-f", ffmpeg.format, outputUrl);
	return args;
}
