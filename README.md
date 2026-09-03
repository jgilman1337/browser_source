# puppeteer_srt_streamer

Capture audio and video from a website using Chromium in Docker (Xvfb + PulseAudio), encode with FFmpeg, and push to **SRT, RTMP, or any FFmpeg output URL**.

Built with **[Bun](https://bun.sh)**. **Docker is only for running the streamer** — the image is immutable at runtime (only `config.json` is mounted in). Lint, format, and typecheck run **on the host**.

## How it works

```
Website
  → Puppeteer (Chromium)
  → puppeteer-stream (WebM capture)
  → FFmpeg (encode + mux)
  → outputUrl (SRT / RTMP / file / …)
  → ffplay / Restreamer / nginx-rtmp / …
```

**Not a direct broadcast source.** This produces a simple capture/encode feed (mezzanine) for ingest — push it to something like [Restreamer](https://datarhei.github.io/restreamer/), MediaMTX, or nginx-rtmp that handles bitrates, transcoding, recording, and fan-out to viewers. `ffplay` is for local testing only. Bitrate and quality tuning belong downstream unless you need to cap upload bandwidth (`ffmpeg.extraArgs`).

puppeteer-stream always outputs **WebM (VP8/VP9)**. FFmpeg re-encodes (H.264 via CPU, NVENC, VAAPI, QSV, etc.) for most streaming targets.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (run the streamer only)
- [Bun](https://bun.sh) ≥ 1.4 (host tooling: install deps, lint, format, typecheck)
- [ffplay](https://ffmpeg.org/ffplay.html) (or another listener) for local SRT testing
- **Optional:** NVIDIA GPU + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) for `h264_nvenc` (`docker:run` passes `--gpus all`)

Install host dependencies once:

```bash
bun install
```

## Quick start (local SRT testing)

### 1. Create your config

```bash
cp config.example.json config.json
```

Edit `config.json`. Only two fields are required — everything else uses defaults (720p30, libx264, mpegts, etc.):

```json
{
	"targetUrl": "https://your-livestream-page.com",
	"outputUrl": "srt://host.docker.internal:5000?mode=caller"
}
```

Optional overrides: `width`, `height`, `frameRate`, `clickPlayTarget`, `hideScrollbars`, `embedAsMedia`, `navigation`, `stream`, `ffmpeg`, `puppeteer`. See [Configuration](#configuration).

`config.json` is gitignored. Commit changes to `config.example.json` as a template only.

### 2. Start an SRT listener on the host

In a separate terminal:

```bash
ffplay -i "srt://0.0.0.0:5000?mode=listener"
```

### 3. Run the streamer

```bash
bun run docker:run
```

`docker:run` rebuilds the image, then starts the container. It mounts `config.json` at `/app/config.json` (read-only). Logs stream to your terminal — look for `Output: srt://...` at startup. Press `Ctrl+C` to stop; the container is removed automatically (`--rm`).

Use `bun run docker:build` alone when you only want to rebuild without running.

### Reaching the host from Docker

The container pushes to **`host.docker.internal`**, not `localhost`. Inside the container, `localhost` refers to the container itself.

| Where                                   | Address                                       |
| --------------------------------------- | --------------------------------------------- |
| ffplay listener (host)                  | `srt://0.0.0.0:5000?mode=listener`            |
| streamer `outputUrl` (container → host) | `srt://host.docker.internal:5000?mode=caller` |

`bun run docker:run` adds `--add-host=host.docker.internal:host-gateway` so this works on Linux. Docker Desktop provides `host.docker.internal` automatically on Mac/Windows.

## Output formats

`outputUrl` + `ffmpeg.format` choose the protocol/container. Common pairings:

| Target | `outputUrl` example                  | `ffmpeg.format` | Notes                            |
| ------ | ------------------------------------ | --------------- | -------------------------------- |
| SRT    | `srt://host:5000?mode=caller`        | `mpegts`        | Local testing with ffplay        |
| RTMP   | `rtmp://ingest.example.com/live/key` | `flv`           | YouTube/Twitch-style ingest      |
| File   | `/tmp/out.mp4`                       | `mp4`           | Debug recording (mount a volume) |

Example **RTMP** config:

```json
{
	"outputUrl": "rtmp://localhost:1935/live/stream",
	"ffmpeg": {
		"videoCodec": "libx264",
		"audioCodec": "aac",
		"format": "flv"
	}
}
```

Example **NVENC** (GPU encode, lower CPU):

```json
{
	"ffmpeg": {
		"videoCodec": "h264_nvenc",
		"audioCodec": "aac",
		"format": "mpegts",
		"extraArgs": ["-b:v", "4M"]
	}
}
```

Run with GPU access via `bun run docker:run` (requires NVIDIA drivers + container toolkit on the host).

Legacy configs using `srtUrl` still work — it is migrated to `outputUrl` at load time.

## Configuration

Runtime settings live in **`config.json`**, loaded at startup via the `CONFIG_PATH` environment variable (defaults to `/app/config.json` in Docker, `./config.json` locally).

**Required:**

| Field       | Description               |
| ----------- | ------------------------- |
| `targetUrl` | Website to capture        |
| `outputUrl` | FFmpeg output destination |

**Optional** (defaults in `src/config_defaults.ts`):

| Field                | Default                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `width`              | `1280`                                                                            |
| `height`             | `720`                                                                             |
| `frameRate`          | `30`                                                                              |
| `clickPlayTarget`    | _(unset)_ — CSS selector for a play/start button to click after load              |
| `hideScrollbars`     | `false` — hide horizontal and vertical scrollbars in the capture                  |
| `embedAsMedia`       | _(unset)_ — `"audio"` or `"video"` to load a direct stream URL in a media element |
| `navigation.timeoutMs` | `60000` — max wait for page load and selector waits (`0` = no timeout)          |
| `navigation.waitUntil` | `load` — Puppeteer lifecycle to wait for (`domcontentloaded`, `networkidle0`, `networkidle2`) |
| `stream.audio`       | `true`                                                                            |
| `stream.video`       | `true`                                                                            |
| `ffmpeg.videoCodec`  | `libx264`                                                                         |
| `ffmpeg.audioCodec`  | `aac`                                                                             |
| `ffmpeg.format`      | `mpegts`                                                                          |
| `ffmpeg.hideBanner`  | `true`                                                                            |
| `ffmpeg.logLevel`    | `warning`                                                                         |
| `ffmpeg.stats`       | `true`                                                                            |
| `ffmpeg.statsPeriod` | `5`                                                                               |
| `ffmpeg.extraArgs`   | `[]`                                                                              |
| `puppeteer.headless` | `false`                                                                           |
| `puppeteer.args`     | Docker-safe Chromium flags (no-sandbox, etc.)                                     |

Unsupported `videoCodec`, `audioCodec`, `format`, or `logLevel` values **fail at startup** with a list of allowed options.

### Play button click (`clickPlayTarget`)

Some sites block autoplay until the user clicks a play or start control. Set `clickPlayTarget` to a CSS selector for that element; after navigation the streamer waits for it to be visible, clicks it, then nudges any `<video>` / `<audio>` elements as usual.

```json
{
	"targetUrl": "https://your-livestream-page.com",
	"outputUrl": "srt://host.docker.internal:5000?mode=caller",
	"clickPlayTarget": ".play-button"
}
```

Omit the field when the page starts playback without a click.

### Hide scrollbars (`hideScrollbars`)

Set `hideScrollbars` to `true` to inject CSS that hides horizontal and vertical scrollbars before the page renders. Content can still scroll programmatically; only the scrollbar UI is removed from the capture.

```json
{
	"hideScrollbars": true
}
```

### Direct media stream URLs (`embedAsMedia`)

Chromium already follows HTTP redirects (301, 302, etc.) automatically. If `targetUrl` points at a **raw media stream** rather than an HTML page — for example a radio manifest that redirects to `audio/aacp` — `page.goto()` fails with `net::ERR_ABORTED` because there is no page to render.

Set `embedAsMedia` to `"audio"` or `"video"` to load the URL in a minimal HTML page with an `<audio>` or `<video>` element. The browser follows redirects when fetching the media `src`, which works for stream URLs like Amperwave/IceCast manifests.

```json
{
	"targetUrl": "https://live.amperwave.net/manifest/audacy-kroqfmaac-imc",
	"outputUrl": "srt://host.docker.internal:5000?mode=caller",
	"embedAsMedia": "audio"
}
```

Use a normal web player URL (e.g. `https://www.audacy.com/kroq`) without `embedAsMedia` when you want to capture a full website.

### Navigation timeouts (`navigation`)

Page load uses Puppeteer's `waitUntil` and `timeoutMs` settings. The default is `load` with a 60s timeout — stricter modes like `networkidle2` often time out on ad-heavy or always-on streaming sites because the network never goes idle.

```json
{
	"navigation": {
		"timeoutMs": 60000,
		"waitUntil": "load"
	}
}
```

| `waitUntil`        | When to use |
| ------------------ | ----------- |
| `domcontentloaded` | Fastest — DOM ready, resources may still be loading |
| `load`             | Default — `load` event fired (images, stylesheets) |
| `networkidle0`     | No network connections for 500ms (strict) |
| `networkidle2`     | At most 2 connections for 500ms (often times out on live sites) |

Set `timeoutMs` to `0` to disable the navigation timeout. The same timeout applies to `clickPlayTarget` selector waits.

FFmpeg logging is quiet by default: the copyright banner is hidden (`-hide_banner`), encoding progress prints every 5 seconds (`-stats_period 5` instead of FFmpeg's 0.5s), and `-loglevel` is `warning`. Set `stats` to `false` to disable progress entirely. `logLevel` accepts FFmpeg's named levels: `quiet`, `panic`, `fatal`, `error`, `warning`, `info`, `verbose`, `debug`, `trace`.

### Supported video encoders (`ffmpeg.videoCodec`)

| Family                  | Codecs                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| CPU                     | `libx264`, `libx265`                                                                            |
| NVIDIA NVENC            | `h264_nvenc`, `hevc_nvenc`                                                                      |
| VAAPI (Intel/AMD Linux) | `h264_vaapi`, `hevc_vaapi`, `mjpeg_vaapi`, `mpeg2_vaapi`, `vp8_vaapi`, `vp9_vaapi`, `av1_vaapi` |
| Intel QSV               | `h264_qsv`, `hevc_qsv`, `mjpeg_qsv`, `mpeg2_qsv`, `vp9_qsv`                                     |
| AMD AMF                 | `h264_amf`, `hevc_amf`, `av1_amf`                                                               |
| V4L2 mem2mem            | `h264_v4l2m2m`, `hevc_v4l2m2m`, `h263_v4l2m2m`, `mpeg4_v4l2m2m`, `vp8_v4l2m2m`                  |

Known encoders get low-latency tuning automatically (e.g. `libx264` → `veryfast`, NVENC → `p1+ull`, VAAPI/QSV → hwupload). Override with `extraArgs` (bitrate, GOP, etc.).

VAAPI device path defaults to `/dev/dri/renderD128`; override with `VAAPI_DEVICE` env var. `docker:run` passes `--gpus all` and `--device /dev/dri` for NVIDIA + Intel/AMD encode.

Xvfb color depth is fixed at 24-bit in code. `width` and `height` also size the virtual display at container start.

Copy `config.example.json` when setting up a new environment:

```bash
cp config.example.json config.json
```

## Scripts

All scripts are run with Bun (`bun run <script>`). npm is not supported.

### Docker (run the streamer only)

| Script                 | Description                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `bun run docker:build` | Build the `puppeteer-srt-streamer` image only                           |
| `bun run docker:run`   | Rebuild + run (`--gpus all`, `--device /dev/dri`, mounts `config.json`) |

The container only receives a read-only `config.json` mount. Source, lint rules, and formatter config are baked into the image at build time and are not modified at runtime.

### Host tooling (lint / format / typecheck)

| Script                 | Description          |
| ---------------------- | -------------------- |
| `bun run lint`         | ESLint               |
| `bun run lint:fix`     | ESLint with auto-fix |
| `bun run format`       | Prettier (write)     |
| `bun run format:check` | Prettier (check)     |
| `bun run typecheck`    | `tsc --noEmit`       |

Requires `bun install` on the host (`node_modules/`).

### Typical workflow

```bash
bun install
cp config.example.json config.json
# edit config.json

ffplay -i "srt://0.0.0.0:5000?mode=listener"   # separate terminal

bun run docker:run

# before committing (on the host)
bun run lint
bun run format:check
bun run typecheck
```

## Project structure

```
puppeteer_srt_streamer/
├── src/
│   ├── index.ts              # Pipeline orchestration + fail-fast shutdown
│   ├── config.ts             # Config loader + types
│   ├── config_defaults.ts    # Default values (720p30, ffmpeg, puppeteer)
│   ├── ffmpeg.ts             # FFmpeg arg builder (codecs, formats)
│   ├── autoplay.ts           # Chromium autoplay helpers
│   └── logger.ts             # Timestamped logging
├── scripts/
│   └── docker-entrypoint.sh  # PulseAudio null sink + Xvfb + app start
├── config.example.json       # Template (committed)
├── config.json               # Your config (gitignored, mounted into container)
├── Dockerfile
├── package.json              # bun scripts (primary interface)
├── bun.lock
└── bunfig.toml
```

## Docker details

- **Base image:** `debian:bookworm-slim`
- **Runtime:** Bun (production deps only in the image)
- **Display/audio:** Xvfb (virtual display) + PulseAudio null sink (tab audio capture)
- **Config:** `config.json` mounted at `/app/config.json` via `docker:run`
- **Host access:** `--add-host=host.docker.internal:host-gateway`
- **Init process:** `--init` (required — without it the container can hang silently with no app logs)
- **Shared memory:** `--shm-size=2g`
- **GPU:** `docker:run` passes `--gpus all` and `--device /dev/dri`; FFmpeg includes NVENC, VAAPI, and QSV encoders (host driver/libs required at runtime)
- **Failures:** FFmpeg or browser errors exit the container (non-zero) instead of hanging

## Troubleshooting

### ffplay shows nothing

1. **Quote the URL** — bash treats `?` as a glob. Without quotes, `mode=listener` is stripped:
    ```bash
    ffplay -i "srt://0.0.0.0:5000?mode=listener"
    ```
2. Start ffplay **before** `bun run docker:run`.
3. Confirm `outputUrl` uses `host.docker.internal`, not `localhost`.
4. `docker:run` rebuilds automatically. Check logs for `Output: srt://...` at startup and that FFmpeg does **not** say `to 'undefined'`.
5. `no sockets to check, this would deadlock` on Ctrl+C before a caller connects is a harmless libsrt shutdown message.

### ffplay shows audio but no video

puppeteer-stream outputs **WebM (VP8/VP9)**. MPEG-TS players expect **H.264**, so `-c:v copy` muxes video as unusable private data — you hear audio only.

Use `libx264` or `h264_nvenc` in `config.json` (default is `libx264`).

### NVENC fails inside Docker

1. Host has NVIDIA drivers and the [container toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed.
2. `docker:run` already passes `--gpus all` — without the toolkit, Docker will refuse to start the container.
3. Verify encoders in the image: `docker run --rm puppeteer-srt-streamer ffmpeg -encoders 2>/dev/null | grep nvenc`
4. Fall back to `"videoCodec": "libx264"` in `config.json` if the GPU is unavailable.

### Chromium crashes

`docker:run` already passes `--shm-size=2g` and `--disable-dev-shm-usage` is in the default Puppeteer args.

## Why Xvfb and PulseAudio (not Wayland / PipeWire)

This container runs headful Chromium in Docker with no physical display or sound card. Xvfb and a PulseAudio null sink are **plumbing**, not the capture path — puppeteer-stream reads from Chromium's tab capture API (WebM), not from the framebuffer or audio server.

```
Chromium → Xvfb (RAM framebuffer)          ← render surface only
         → PulseAudio null sink           ← fake output so tab audio works
         → puppeteer-stream (tab capture) → FFmpeg → outputUrl
```

**Xvfb (X11)** is a minimal virtual framebuffer: no compositor, no input, no window manager. **Wayland** has no equivalent standalone server — you run a full compositor (e.g. Weston headless), which is heavier for the same job. Wayland makes sense on a real desktop; here we only need something for Chromium to paint into.

**PulseAudio null sink** is a single fake output device. **PipeWire** would add wireplumber and often a Pulse compatibility layer, with no benefit for one null sink. PipeWire shines on desktops (Bluetooth, JACK replacement, multi-app routing).

|         | This container          | Desktop                      |
| ------- | ----------------------- | ---------------------------- |
| Display | Xvfb (fake framebuffer) | Wayland compositor → monitor |
| Audio   | Pulse null sink         | PipeWire → speakers          |
| Capture | Tab API (bypasses both) | N/A                          |

If Chromium ever drops X11 in containers, the likely migration is Weston headless + `--ozone-platform=wayland` — swap the entrypoint, keep the puppeteer-stream → FFmpeg pipeline. Chromium still maintains an Ozone/X11 backend today and falls back to X11 when no Wayland server is present.

**Packaged alternative:** [xwfb-run](https://manpages.debian.org/unstable/xwayland-run/xwfb-run.1.en.html) (`xwayland-run` package) is a drop-in replacement for `xvfb-run` — it starts a headless Wayland compositor (Weston by default) plus rootful Xwayland. Same role as our `xvfb-run` wrapper in `scripts/docker-entrypoint.sh`, but heavier (compositor + Xwayland + X11 instead of Xvfb alone). Useful if Xvfb disappears from Debian or you need to test Chromium on Wayland in CI; not worth switching to for a smaller image or lower overhead today.

## License

AGPL v3 (see [LICENSE.txt](LICENSE.txt)).
