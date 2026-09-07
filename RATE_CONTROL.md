# Rate control (`ffmpeg.extraArgs`)

FFmpeg rate-control flags go in `ffmpeg.extraArgs`. The app **does not** infer `-maxrate` or `-bufsize` from `-b:v`. If you omit them, FFmpeg uses the encoder’s own defaults.

`stream.videoMbitsPerSecond` is the **Chrome tab-capture** bitrate (WebM VP8/VP9), not the FFmpeg VBV buffer. Keep capture at or above the encode ceiling (`-maxrate`, or `-b:v` for CBR) so capture is not the bottleneck.

Audio (`-b:a`) is independent. These notes apply to **video** rate control. NVENC already gets `p4` + `hq` + AQ from the encoder profile; you only add `-rc` and bitrate flags here.

For NVENC, set `-rc` explicitly. `-b:v` alone is ignored.

## CBR vs VBR

**CBR** is the usual default for a livestream (SRT → Restreamer / YouTube / Twitch). Bitrate stays flat, so ingest can size buffers and bandwidth around a number it can count on. Quality can dip on hard scenes.

**VBR** spends more bits on complex frames and fewer on easy ones, so the same *average* often looks better. Peaks can exceed the average; live pipelines often dislike that.

Use **CBR** when something downstream assumes a cap, latency matters, or the uplink is close to the target bitrate.

Use **VBR** when you control the whole path (file, VOD, a private hop with headroom) and quality matters more than a flat graph.

If motion looks blocky on a live ingest path, raising CBR (`-b:v` / `-maxrate`) is usually more reliable than switching to VBR.

## Buffer size (`-bufsize`)

`-bufsize` is the VBV (decoder) buffer. A larger buffer lets the encoder deviate from the target rate for longer; a smaller one forces it closer to `-b:v` / `-maxrate`.

Typical ratios:

| Use | `-bufsize` vs rate |
| --- | --- |
| Tight CBR / low latency live | ~1× `-b:v` (same as `-maxrate`) |
| Normal CBR streaming | ~2× `-b:v` |
| VBR | ~2× `-maxrate` (not 2× `-b:v`) |
| VBR with more quality headroom | ~2–4× `-maxrate` |

Closer to 1×: more constant bitrate, harsher quality swings, less mux/player delay. Closer to 2× (or a bit more): smoother quality, more bitrate wiggle, a bit more buffering.

For CBR, keep `-b:v` and `-maxrate` the same.

## CBR profile (NVENC)

`-b:v` and `-maxrate` equal; `-bufsize` about 2× that value.

```json
"extraArgs": [
	"-rc", "cbr",
	"-b:v", "3M",
	"-maxrate", "3M",
	"-bufsize", "6M",
	"-b:a", "192k"
]
```

Drop `-bufsize` toward `3M` only if you care more about latency and a flatter bitrate graph.

## VBR profile (NVENC)

`-b:v` is the **average**. `-maxrate` is the **ceiling** (typically 1.5–2× `-b:v`). `-bufsize` is about **2× `-maxrate`**. `-cq` is the quality target (lower ≈ better / more bits; try `19`–`21` for cleaner output, `25`–`28` to save bandwidth).

```json
"extraArgs": [
	"-rc", "vbr",
	"-cq", "23",
	"-b:v", "3M",
	"-maxrate", "6M",
	"-bufsize", "12M",
	"-b:a", "192k"
]
```

`4.5M` maxrate is a tighter cap than `6M`. Audio stays CBR (`-b:a`); only video is VBR.

For SRT → Restreamer → typical platform ingest, prefer CBR unless you have spare bandwidth and the next hop accepts bursts.
