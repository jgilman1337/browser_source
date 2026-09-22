/**
 * Configuration loader for the browser capture streamer.
 *
 * Validation is two-phase:
 *   1. `streamerConfigInputSchema` — loose parse of config.json (partial fields)
 *   2. Merge with `DEFAULT_STREAMER_CONFIG`, then `streamerConfigSchema` — fully resolved config
 *
 * Only `targetUrl` and `outputUrl` are required in config.json — everything else uses defaults
 * in defaults.ts. See config.example.json and README.md.
 */
import { access, readFile } from "@/platform/fs";
import type { BrowserMimeType } from "puppeteer-stream";
import { z } from "zod";

import { DEFAULT_STREAMER_CONFIG, NAVIGATION_WAIT_UNTIL, XVFB_COLOR_DEPTH } from "@/config/defaults";
import { ffmpegSchema, parseFfmpegConfig, supportedEnum } from "@/streaming/ffmpeg-config";

/** Zod schema for puppeteer-stream `BrowserMimeType` (compile-time union, runtime string). */
function browserMimeTypeSchema(field: string) {
	return z.custom<BrowserMimeType>(
		(value): value is BrowserMimeType => typeof value === "string" && value.length > 0,
		{ error: `${field} must be a puppeteer-stream BrowserMimeType string` },
	);
}

/** `buffer` block — decoded-frame cushion before the compositor sends to `outputUrl`. */
const bufferSchema = z.object({
	/** Seconds of raw video to accumulate on startup and after each reload/navigate; `0` disables. */
	preloadSeconds: z.number().min(0, "buffer.preloadSeconds must be a non-negative number of seconds."),
});

/** `navigation` block — Puppeteer page.goto / setContent waitUntil and timeout. */
export const navigationSchema = z.object({
	timeoutMs: z.number().min(0, "navigation.timeoutMs must be a non-negative number (0 disables the timeout)."),
	waitUntil: supportedEnum(NAVIGATION_WAIT_UNTIL, "navigation.waitUntil"),
	/** Seconds between play-button selector retries after the page has loaded. */
	clickRetryAfter: z.number().min(0, "navigation.clickRetryAfter must be a non-negative number of seconds."),
	/** Seconds to keep retrying the play-button selector before giving up. */
	clickTimeout: z.number().positive("navigation.clickTimeout must be a positive number of seconds."),
	/** Hours between proactive page and browser-capture refreshes; zero disables automatic refreshes. */
	reloadAfterHours: z.number().min(0, "navigation.reloadAfterHours must be a non-negative number of hours."),
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

/** HTTP control server settings. */
const controlSchema = z.object({
	host: z.string().min(1),
	port: z.number().int().min(1).max(65535),
});

/** Administrative authentication settings. */
const authSchema = z.object({
	admin_password: z.string().min(1).optional(),
});

/**
 * Fully resolved streamer config after defaults are merged.
 * This is the shape consumed by the application entrypoint, streaming modules, and
 * docker-entrypoint.sh (via xvfbScreenArgs).
 */
export const streamerConfigSchema = z.object({
	targetUrl: z.string().min(1, "config.json must set targetUrl."),
	outputUrl: z.string().min(1),
	clickPlayTarget: z.string().min(1).optional(),
	hideScrollbars: z.boolean(),
	embedAsMedia: z.enum(["audio", "video"]).optional(),
	buffer: bufferSchema,
	navigation: navigationSchema,
	width: z.number().positive(),
	height: z.number().positive(),
	frameRate: z.number().positive(),
	stream: streamSchema,
	puppeteer: puppeteerSchema,
	control: controlSchema,
	auth: authSchema,
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
	const { stream, puppeteer, ffmpeg, navigation, buffer, control, auth, ...rest } = input;

	const merged = {
		...DEFAULT_STREAMER_CONFIG,
		...rest,
		buffer: { ...DEFAULT_STREAMER_CONFIG.buffer, ...buffer },
		navigation: { ...DEFAULT_STREAMER_CONFIG.navigation, ...navigation },
		stream: { ...DEFAULT_STREAMER_CONFIG.stream, ...stream },
		puppeteer: { ...DEFAULT_STREAMER_CONFIG.puppeteer, ...puppeteer },
		control: { ...DEFAULT_STREAMER_CONFIG.control, ...control },
		auth: { ...DEFAULT_STREAMER_CONFIG.auth, ...auth },
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
