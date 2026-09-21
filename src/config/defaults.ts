import type { BrowserMimeType } from "puppeteer-stream";

/** Xvfb bit depth — fixed at 24-bit true color; not exposed in config.json. */
export const XVFB_COLOR_DEPTH = 24;

/** Default capture resolution: 720p30. */
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;
export const DEFAULT_FRAME_RATE = 30;

/** Default stream configuration. */
export const DEFAULT_STREAM = {
	audio: true,
	video: true,
	/** MediaRecorder VP8/VP9 capture bitrate in Mbit/s — low defaults (~2.5 Mbps) cause visible artifacts before FFmpeg. */
	videoMbitsPerSecond: 8,
	/** MediaRecorder Opus/Vorbis capture bitrate for tab audio, in kbit/s. */
	audioKbitsPerSecond: 192,
	/** VP9 compresses gradients better than VP8; fall back to `video/webm;codecs=vp8` if capture fails. */
	mimeType: "video/webm;codecs=vp9" satisfies BrowserMimeType,
} as const;

/** Docker-safe Chromium flags — baked in unless overridden. */
export const DEFAULT_PUPPETEER_DOCKER_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
] as const;

/**
 * GPU acceleration for Chromium in Docker.
 * Requires `docker:run` (`--gpus all`, `/dev/dri`) and host GPU drivers.
 */
export const DEFAULT_PUPPETEER_GPU_ARGS = [
	"--enable-gpu",
	"--ignore-gpu-blocklist",
	"--disable-gpu-sandbox",
	"--use-gl=angle",
	"--use-angle=vulkan",
	"--enable-features=VaapiVideoDecoder,VaapiIgnoreDriverChecks,Vulkan",
] as const;

export const DEFAULT_PUPPETEER_ARGS = [...DEFAULT_PUPPETEER_DOCKER_ARGS, ...DEFAULT_PUPPETEER_GPU_ARGS] as const;

/** Default FFmpeg configuration. */
export const DEFAULT_FFMPEG = {
	videoCodec: "libx264",
	audioCodec: "aac",
	format: "mpegts",
	extraArgs: [] as string[],
	hideBanner: true,
	logLevel: "warning",
	stats: true,
	statsPeriod: 5,
	/** Extra FFmpeg launches after a failed/exited process (connection drop, timeout, refused). */
	retries: 10,
	/** Seconds to wait before each FFmpeg retry. */
	retryAfter: 5,
};

/** puppeteer-stream requires a rendered surface — never default to headless. */
export const DEFAULT_PUPPETEER_HEADLESS = false;

/** Puppeteer waitUntil values for page.goto / page.setContent. */
export const NAVIGATION_WAIT_UNTIL = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

/** Default navigation — `load` suits ad/stream-heavy pages; `networkidle2` often times out. */
export const DEFAULT_NAVIGATION = {
	timeoutMs: 15_000,
	waitUntil: "load" as (typeof NAVIGATION_WAIT_UNTIL)[number],
	/** Seconds between play-button selector retries. */
	clickRetryAfter: 5,
	/** Seconds to keep looking for the play-button selector. */
	clickTimeout: 30,
	/** Hours between proactive page and browser-capture refreshes. */
	reloadAfterHours: 12,
};

/** Default HTTP control server settings. */
export const DEFAULT_CONTROL = {
	host: process.env.CONTROL_HOST ?? "127.0.0.1",
	port: 8787,
} as const;

/** Default streamer settings — `targetUrl` and `outputUrl` come from config.json. */
export const DEFAULT_STREAMER_CONFIG = {
	width: DEFAULT_WIDTH,
	height: DEFAULT_HEIGHT,
	frameRate: DEFAULT_FRAME_RATE,
	hideScrollbars: false,
	navigation: { ...DEFAULT_NAVIGATION },
	stream: { ...DEFAULT_STREAM },
	puppeteer: {
		headless: DEFAULT_PUPPETEER_HEADLESS,
		args: [...DEFAULT_PUPPETEER_ARGS],
	},
	control: { ...DEFAULT_CONTROL },
	auth: {},
	ffmpeg: {
		...DEFAULT_FFMPEG,
		extraArgs: [...DEFAULT_FFMPEG.extraArgs],
	},
};
