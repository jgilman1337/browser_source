/**
 * Configuration loader for the browser capture streamer.
 *
 * Runtime settings live in config.json (see config.example.json). The file path
 * is controlled by CONFIG_PATH so Docker can mount config.json without rebuilding
 * the image.
 */
import { access, readFile } from "node:fs/promises";

import { validateFfmpegConfig } from "./ffmpeg.js";

/** Xvfb bit depth — fixed at 24-bit true color; not exposed in config.json. */
const XVFB_COLOR_DEPTH = 24;

/** Shape of config.json — keep in sync with config.example.json. */
export interface StreamerConfig {
	/** Page to open and capture (must actually play media for a non-black stream). */
	targetUrl: string;
	/** FFmpeg output destination — protocol is inferred from the URL (srt://, rtmp://, file path, etc.). */
	outputUrl: string;
	/** Capture width in pixels — also drives viewport, Xvfb, and MediaRecorder constraints. */
	width: number;
	/** Capture height in pixels — also drives viewport, Xvfb, and MediaRecorder constraints. */
	height: number;
	/** Target output frame rate. */
	frameRate: number;
	stream: {
		audio: boolean;
		video: boolean;
	};
	puppeteer: {
		/** Must stay false — puppeteer-stream needs a rendered surface (Xvfb provides one in Docker). */
		headless: boolean;
		args: string[];
	};
	ffmpeg: {
		/** See SUPPORTED_VIDEO_CODECS in ffmpeg.ts — libx264, h264_nvenc, h264_vaapi, h264_qsv, etc. */
		videoCodec: string;
		audioCodec: string;
		/** Output muxer — see SUPPORTED_OUTPUT_FORMATS in ffmpeg.ts (mpegts, flv, mp4, …). */
		format: string;
		/** Extra FFmpeg flags before -f (e.g. "-b:v", "4M"). */
		extraArgs?: string[];
	};
}

/** Legacy config field — migrated to outputUrl on load. */
type RawStreamerConfig = StreamerConfig & { srtUrl?: string };

/** Resolved path to config.json — CONFIG_PATH in Docker, ./config.json locally. */
export function getConfigPath(): string {
	return process.env.CONFIG_PATH ?? `${process.cwd()}/config.json`;
}

/** Resolved output URL — prefers outputUrl, falls back to legacy srtUrl. */
export function resolveOutputUrl(config: RawStreamerConfig): string {
	if (config.outputUrl) {
		return config.outputUrl;
	}
	if (config.srtUrl) {
		return config.srtUrl;
	}
	throw new Error("config.json must set outputUrl (or legacy srtUrl).");
}

/** Load and parse config.json. Fails fast with a helpful message if the file is missing. */
export async function loadConfig(): Promise<StreamerConfig> {
	const path = getConfigPath();

	try {
		await access(path);
	} catch {
		throw new Error(`Config not found at ${path}. Copy config.example.json to config.json.`);
	}

	const raw = await readFile(path, "utf-8");
	const parsed = JSON.parse(raw) as RawStreamerConfig;
	const outputUrl = resolveOutputUrl(parsed);

	const config: StreamerConfig = {
		...parsed,
		outputUrl,
	};

	validateFfmpegConfig(config.ffmpeg);

	return config;
}

/**
 * Xvfb screen argument string (WIDTHxHEIGHTxDEPTH).
 * Used by scripts/docker-entrypoint.sh to size the virtual display before the app starts.
 */
export function xvfbScreenArgs(config: StreamerConfig): string {
	return `${config.width}x${config.height}x${XVFB_COLOR_DEPTH}`;
}
