/**
 * Configuration loader for the browser capture streamer.
 *
 * Only `targetUrl` and `outputUrl` are required in config.json — everything else
 * uses defaults in config_defaults.ts. See config.example.json.
 */
import { access, readFile } from "node:fs/promises";

import { DEFAULT_STREAMER_CONFIG, XVFB_COLOR_DEPTH } from "./config_defaults.js";
import { validateFfmpegConfig } from "./ffmpeg.js";

/** The core configuration interface for the streamer. */
export interface StreamerConfig {
	targetUrl: string;
	outputUrl: string;
	width: number;
	height: number;
	frameRate: number;
	stream: {
		audio: boolean;
		video: boolean;
	};
	puppeteer: {
		headless: boolean;
		args: string[];
	};
	ffmpeg: {
		videoCodec: string;
		audioCodec: string;
		format: string;
		extraArgs?: string[];
	};
}

/** Resolved path to config.json — CONFIG_PATH in Docker, ./config.json locally. */
export function getConfigPath(): string {
	return process.env.CONFIG_PATH ?? `${process.cwd()}/config.json`;
}

/** Resolved output URL — prefers outputUrl, falls back to legacy srtUrl. */
export function resolveOutputUrl(config: Partial<StreamerConfig> & { srtUrl?: string }): string {
	if (config.outputUrl) {
		return config.outputUrl;
	}
	if (config.srtUrl) {
		return config.srtUrl;
	}
	throw new Error("config.json must set outputUrl (or legacy srtUrl).");
}

/** Merge user config over DEFAULT_STREAMER_CONFIG. */
export function applyConfigDefaults(parsed: Partial<StreamerConfig> & { srtUrl?: string }): StreamerConfig {
	if (!parsed.targetUrl) {
		throw new Error("config.json must set targetUrl.");
	}

	// Apply the defaults
	const { targetUrl, stream, puppeteer, ffmpeg, width, height, frameRate } = parsed;
	const config: StreamerConfig = {
		...DEFAULT_STREAMER_CONFIG,
		targetUrl,
		outputUrl: resolveOutputUrl(parsed),
		...(width !== undefined ? { width } : {}),
		...(height !== undefined ? { height } : {}),
		...(frameRate !== undefined ? { frameRate } : {}),
		stream: { ...DEFAULT_STREAMER_CONFIG.stream, ...stream },
		puppeteer: { ...DEFAULT_STREAMER_CONFIG.puppeteer, ...puppeteer },
		ffmpeg: { ...DEFAULT_STREAMER_CONFIG.ffmpeg, ...ffmpeg },
	};

	// Validate the FFmpeg configuration
	validateFfmpegConfig(config.ffmpeg);

	return config;
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

	return applyConfigDefaults(JSON.parse(raw));
}

/**
 * Xvfb screen argument string (WIDTHxHEIGHTxDEPTH).
 * Used by scripts/docker-entrypoint.sh to size the virtual display before the app starts.
 */
export function xvfbScreenArgs(config: StreamerConfig): string {
	return `${config.width}x${config.height}x${XVFB_COLOR_DEPTH}`;
}
