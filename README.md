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
- [Bun](https://bun.sh) + [npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) (host tooling: install deps, lint, format, typecheck)
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

Edit `config.json`. The default `outputUrl` targets an SRT listener on your **host machine**:

```json
{
	"targetUrl": "https://your-livestream-page.com",
	"outputUrl": "srt://host.docker.internal:5000?mode=caller",
	"width": 1920,
	"height": 1080,
	"frameRate": 30,
	"ffmpeg": {
		"videoCodec": "libx264",
		"audioCodec": "aac",
		"format": "mpegts"
	}
}
```

`config.json` is gitignored. Commit changes to `config.example.json` as a template only.

### 2. Start an SRT listener on the host

In a separate terminal:

```bash
ffplay -i "srt://0.0.0.0:5000?mode=listener"
```

### 3. Run the streamer

```bash
npm run docker:run
```

`docker:run` rebuilds the image, then starts the container. It mounts `config.json` at `/app/config.json` (read-only). Logs stream to your terminal — look for `Output: srt://...` at startup. Press `Ctrl+C` to stop; the container is removed automatically (`--rm`).

Use `npm run docker:build` alone when you only want to rebuild without running.

### Reaching the host from Docker

The container pushes to **`host.docker.internal`**, not `localhost`. Inside the container, `localhost` refers to the container itself.

| Where                                | Address                                       |
| ------------------------------------ | --------------------------------------------- |
| ffplay listener (host)               | `srt://0.0.0.0:5000?mode=listener`            |
| streamer `outputUrl` (container → host) | `srt://host.docker.internal:5000?mode=caller` |

`npm run docker:run` adds `--add-host=host.docker.internal:host-gateway` so this works on Linux. Docker Desktop provides `host.docker.internal` automatically on Mac/Windows.

## Output formats

`outputUrl` + `ffmpeg.format` choose the protocol/container. Common pairings:

| Target | `outputUrl` example | `ffmpeg.format` | Notes |
| ------ | ------------------- | --------------- | ----- |
| SRT | `srt://host:5000?mode=caller` | `mpegts` | Local testing with ffplay |
| RTMP | `rtmp://ingest.example.com/live/key` | `flv` | YouTube/Twitch-style ingest |
| File | `/tmp/out.mp4` | `mp4` | Debug recording (mount a volume) |

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

Run with GPU access via `npm run docker:run` (requires NVIDIA drivers + container toolkit on the host).

Legacy configs using `srtUrl` still work — it is migrated to `outputUrl` at load time.

## Configuration

Runtime settings live in **`config.json`**, loaded at startup via the `CONFIG_PATH` environment variable (defaults to `/app/config.json` in Docker, `./config.json` locally).

| Field                | Description                     | Default                                       |
| -------------------- | ------------------------------- | --------------------------------------------- |
| `targetUrl`          | Website to capture              | `https://your-livestream-source.com`          |
| `outputUrl`          | FFmpeg output destination       | `srt://host.docker.internal:5000?mode=caller` |
| `width`              | Capture width (px)              | `1920`                                        |
| `height`             | Capture height (px)             | `1080`                                        |
| `frameRate`          | Target frame rate               | `30`                                          |
| `stream.audio`       | Capture audio                   | `true`                                        |
| `stream.video`       | Capture video                   | `true`                                        |
| `ffmpeg.videoCodec`  | See supported encoders below    | `libx264`                                     |
| `ffmpeg.audioCodec`  | `aac`, `libopus`, `libmp3lame`, `ac3` | `aac`                                 |
| `ffmpeg.format`      | `mpegts`, `flv`, `mp4`, `matroska`, `mov`, `nut` | `mpegts`                    |
| `ffmpeg.extraArgs`   | Extra FFmpeg flags before `-f`  | `[]`                                          |
| `puppeteer.headless` | Must be `false` for capture     | `false`                                       |
| `puppeteer.args`     | Chromium launch flags           | see `config.example.json`                     |

Unsupported `videoCodec`, `audioCodec`, or `format` values **fail at startup** with a list of allowed options.

### Supported video encoders (`ffmpeg.videoCodec`)

| Family | Codecs |
| ------ | ------ |
| CPU | `libx264`, `libx265` |
| NVIDIA NVENC | `h264_nvenc`, `hevc_nvenc` |
| VAAPI (Intel/AMD Linux) | `h264_vaapi`, `hevc_vaapi`, `mjpeg_vaapi`, `mpeg2_vaapi`, `vp8_vaapi`, `vp9_vaapi`, `av1_vaapi` |
| Intel QSV | `h264_qsv`, `hevc_qsv`, `mjpeg_qsv`, `mpeg2_qsv`, `vp9_qsv` |
| AMD AMF | `h264_amf`, `hevc_amf`, `av1_amf` |
| V4L2 mem2mem | `h264_v4l2m2m`, `hevc_v4l2m2m`, `h263_v4l2m2m`, `mpeg4_v4l2m2m`, `vp8_v4l2m2m` |

Known encoders get low-latency tuning automatically (e.g. `libx264` → `veryfast`, NVENC → `p1+ull`, VAAPI/QSV → hwupload). Override with `extraArgs` (bitrate, GOP, etc.).

VAAPI device path defaults to `/dev/dri/renderD128`; override with `VAAPI_DEVICE` env var. `docker:run` passes `--gpus all` and `--device /dev/dri` for NVIDIA + Intel/AMD encode.

Xvfb color depth is fixed at 24-bit in code. `width` and `height` also size the virtual display at container start.

Copy `config.example.json` when setting up a new environment:

```bash
cp config.example.json config.json
```

## npm scripts

### Docker (run the streamer only)

| Script                    | Description                                                          |
| ------------------------- | -------------------------------------------------------------------- |
| `npm run docker:build`    | Build the `puppeteer-srt-streamer` image only                        |
| `npm run docker:run`      | Rebuild + run (`--gpus all`, `--device /dev/dri`, mounts `config.json`) |

The container only receives a read-only `config.json` mount. Source, lint rules, and formatter config are baked into the image at build time and are not modified at runtime.

### Host tooling (lint / format / typecheck)

| Script                 | Description          |
| ---------------------- | -------------------- |
| `npm run lint`         | ESLint               |
| `npm run lint:fix`     | ESLint with auto-fix |
| `npm run format`       | Prettier (write)     |
| `npm run format:check` | Prettier (check)     |
| `npm run typecheck`    | `tsc --noEmit`       |

Requires `bun install` on the host (`node_modules/`).

### Typical workflow

```bash
bun install
cp config.example.json config.json
# edit config.json

ffplay -i "srt://0.0.0.0:5000?mode=listener"   # separate terminal

npm run docker:run

# before committing (on the host)
npm run lint
npm run format:check
npm run typecheck
```

## Project structure

```
puppeteer_srt_streamer/
├── src/
│   ├── index.ts              # Pipeline orchestration + fail-fast shutdown
│   ├── config.ts             # Config loader + types
│   ├── ffmpeg.ts             # FFmpeg arg builder (codecs, formats)
│   ├── autoplay.ts           # Chromium autoplay helpers
│   └── logger.ts             # Timestamped logging
├── scripts/
│   └── docker-entrypoint.sh  # PulseAudio null sink + Xvfb + app start
├── config.example.json       # Template (committed)
├── config.json               # Your config (gitignored, mounted into container)
├── Dockerfile
├── package.json              # npm scripts (primary interface)
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
2. Start ffplay **before** `npm run docker:run`.
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

## License

ISC (see `package.json`).
