/**
 * Configuration loader for the browser capture streamer.
 *
 * Validation is two-phase:
 *   1. `streamerConfigInputSchema` — loose parse of config.json (partial fields)
 *   2. Merge with `DEFAULT_STREAMER_CONFIG`, then `streamerConfigSchema` — fully resolved config
 *
 * Only `targetUrl` and `outputUrl` are required in config.json — everything else uses defaults
 * in config_defaults.ts. See config.example.json and README.md.
 */
import { access, readFile } from "node:fs/promises";
import type { BrowserMimeType } from "puppeteer-stream";
import { z } from "zod";

import { DEFAULT_STREAMER_CONFIG, NAVIGATION_WAIT_UNTIL, XVFB_COLOR_DEPTH } from "./config_defaults.js";
import { ffmpegSchema, parseFfmpegConfig, supportedEnum } from "./ffmpeg_config.js";

/** Zod schema for puppeteer-stream `BrowserMimeType` (compile-time union, runtime string). */
function browserMimeTypeSchema(field: string) {
	return z.custom<BrowserMimeType>(
		(value): value is BrowserMimeType => typeof value === "string" && value.length > 0,
		{ error: `${field} must be a puppeteer-stream BrowserMimeType string` },
	);
}

/** `navigation` block — Puppeteer page.goto / setContent waitUntil and timeout. */
export const navigationSchema = z.object({
	timeoutMs: z.number().min(0, "navigation.timeoutMs must be a non-negative number (0 disables the timeout)."),
	waitUntil: supportedEnum(NAVIGATION_WAIT_UNTIL, "navigation.waitUntil"),
});

/** Resolved navigation settings after defaults are applied. */
export type NavigationConfig = z.infer<typeof navigationSchema>;

/** Allowed Puppeteer lifecycle events for `navigation.waitUntil`. */
export type NavigationWaitUntil = NavigationConfig["waitUntil"];

/** `stream` block — which tracks puppeteer-stream captures from the page. */
const streamSchema = z.object({
	audio: z.boolean(),
	video: z.boolean(),
	videoMbitsPerSecond: z.number().positive(),
	audioKbitsPerSecond: z.number().positive(),
	mimeType: browserMimeTypeSchema("stream.mimeType"),
});

/** `puppeteer` block — Chromium launch options (headless is almost always false for capture). */
const puppeteerSchema = z.object({
	headless: z.boolean(),
	args: z.array(z.string()),
});

/**
 * Fully resolved streamer config after defaults are merged.
 * This is the shape consumed by index.ts, ffmpeg.ts, ffmpeg_config.ts, and docker-entrypoint.sh (via xvfbScreenArgs).
 */
export const streamerConfigSchema = z.object({
	targetUrl: z.string().min(1, "config.json must set targetUrl."),
	outputUrl: z.string().min(1),
	clickPlayTarget: z.string().min(1).optional(),
	hideScrollbars: z.boolean(),
	embedAsMedia: z.enum(["audio", "video"]).optional(),
	navigation: navigationSchema,
	width: z.number().positive(),
	height: z.number().positive(),
	frameRate: z.number().positive(),
	stream: streamSchema,
	puppeteer: puppeteerSchema,
	ffmpeg: ffmpegSchema,
});

export type StreamerConfig = z.infer<typeof streamerConfigSchema>;

/**
 * Raw config.json shape — derived from `streamerConfigSchema` via `z.deepPartial()`.
 * Only `targetUrl` and `outputUrl` are required; everything else is optional.
 */
const streamerConfigInputSchema = z.deepPartial(streamerConfigSchema).required({ targetUrl: true, outputUrl: true });

/** Parsed config.json before defaults are merged. */
type StreamerConfigInput = z.infer<typeof streamerConfigInputSchema>;

/** Validate raw JSON from config.json; throws with prettified Zod errors on failure. */
function parseStreamerConfigInput(value: unknown): StreamerConfigInput {
	const result = streamerConfigInputSchema.safeParse(value);
	if (!result.success) {
		throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
	}
	return result.data;
}

/** Resolved path to config.json — CONFIG_PATH in Docker, ./config.json locally. */
export function getConfigPath(): string {
	return process.env.CONFIG_PATH ?? `${process.cwd()}/config.json`;
}

/** Merge user config over DEFAULT_STREAMER_CONFIG and validate the resolved result. */
export function applyConfigDefaults(parsed: unknown): StreamerConfig {
	const input = parseStreamerConfigInput(parsed);
	const { stream, puppeteer, ffmpeg, navigation, ...rest } = input;

	const merged = {
		...DEFAULT_STREAMER_CONFIG,
		...rest,
		navigation: { ...DEFAULT_STREAMER_CONFIG.navigation, ...navigation },
		stream: { ...DEFAULT_STREAMER_CONFIG.stream, ...stream },
		puppeteer: { ...DEFAULT_STREAMER_CONFIG.puppeteer, ...puppeteer },
		ffmpeg: parseFfmpegConfig({ ...DEFAULT_STREAMER_CONFIG.ffmpeg, ...ffmpeg }),
	};

	const result = streamerConfigSchema.safeParse(merged);
	if (!result.success) {
		throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
	}

	return result.data;
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
