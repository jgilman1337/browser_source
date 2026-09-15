#!/bin/sh
set -e

CONFIG_PATH="${CONFIG_PATH:-/app/config.json}"
RUN_TS="$(dirname "$0")/run-ts.sh"

echo "[entrypoint] config: ${CONFIG_PATH}" >&2

# Chromium tab-audio capture needs an output device. Docker has no sound card — use a null sink.
PULSE_RUNTIME_PATH="${PULSE_RUNTIME_PATH:-/tmp/pulse-runtime}"
export PULSE_RUNTIME_PATH
mkdir -p "${PULSE_RUNTIME_PATH}"
rm -rf "${PULSE_RUNTIME_PATH:?}"/*
pulseaudio --kill 2>/dev/null || true

if ! pulseaudio --check 2>/dev/null; then
	echo "[entrypoint] starting PulseAudio null sink" >&2
	pulseaudio -D --exit-idle-time=-1 --disallow-exit \
		--load="module-null-sink sink_name=capture"
	sleep 1
	if ! pulseaudio --check 2>/dev/null; then
		echo "[entrypoint] PulseAudio failed to start" >&2
		exit 1
	fi
fi

SCREEN_ARGS=$("${RUN_TS}" scripts/xvfb-screen-args.ts)

echo "[entrypoint] xvfb screen: ${SCREEN_ARGS}" >&2

exec xvfb-run --auto-servernum --server-args="-screen 0 ${SCREEN_ARGS}" "${RUN_TS}" src/index.ts
