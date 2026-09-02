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
};

/** puppeteer-stream requires a rendered surface — never default to headless. */
export const DEFAULT_PUPPETEER_HEADLESS = false;

/** Default streamer settings — `targetUrl` and `outputUrl` come from config.json. */
export const DEFAULT_STREAMER_CONFIG = {
	width: DEFAULT_WIDTH,
	height: DEFAULT_HEIGHT,
	frameRate: DEFAULT_FRAME_RATE,
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
