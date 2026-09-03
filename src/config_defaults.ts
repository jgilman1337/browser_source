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
} as const;

/** Docker-safe Chromium flags — baked in unless overridden. */
export const DEFAULT_PUPPETEER_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] as const;

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
};

/** puppeteer-stream requires a rendered surface — never default to headless. */
export const DEFAULT_PUPPETEER_HEADLESS = false;

/** Puppeteer waitUntil values for page.goto / page.setContent. */
export const NAVIGATION_WAIT_UNTIL = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

/** Default navigation — `load` suits ad/stream-heavy pages; `networkidle2` often times out. */
export const DEFAULT_NAVIGATION = {
	timeoutMs: 15_000,
	waitUntil: "load" as (typeof NAVIGATION_WAIT_UNTIL)[number],
};

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
	ffmpeg: {
		...DEFAULT_FFMPEG,
		extraArgs: [...DEFAULT_FFMPEG.extraArgs],
	},
};
