#!/bin/sh
set -eu

LISTEN_URL="${SRT_LISTEN_URL:-srt://0.0.0.0:5000?mode=listener}"

cleanup() {
	exit 0
}

trap cleanup INT TERM

echo "[listen] waiting for SRT caller at ${LISTEN_URL}" >&2

while :; do
	ffplay -i "${LISTEN_URL}" || true
	echo "[listen] stream ended; waiting for the next caller..." >&2
	sleep 1
done
