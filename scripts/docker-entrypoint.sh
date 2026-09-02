#!/bin/sh
set -e

CONFIG_PATH="${CONFIG_PATH:-/app/config.json}"

echo "[entrypoint] config: ${CONFIG_PATH}" >&2

# Chromium tab-audio capture needs an output device. Docker has no sound card — use a null sink.
if ! pulseaudio --check 2>/dev/null; then
	echo "[entrypoint] starting PulseAudio null sink" >&2
	pulseaudio -D --exit-idle-time=-1 --disallow-exit \
		--load="module-null-sink sink_name=capture"
	sleep 1
fi

SCREEN_ARGS=$(bun -e "
const { readFileSync } = require('node:fs');
const config = JSON.parse(readFileSync('${CONFIG_PATH}', 'utf8'));
process.stdout.write(\`\${config.width}x\${config.height}x24\`);
")

echo "[entrypoint] xvfb screen: ${SCREEN_ARGS}" >&2

# Run the app directly — "bun run start" can hang silently under xvfb-run (no TTY).
exec xvfb-run --auto-servernum --server-args="-screen 0 ${SCREEN_ARGS}" bun src/index.ts
