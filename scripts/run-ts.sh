#!/bin/sh
# Execute TypeScript under an explicit runtime. Default is Node (production).
# Docker images set STREAMER_RUNTIME=node or STREAMER_RUNTIME=bun so this never
# silently picks whichever interpreter happens to be on PATH.
set -eu

case "${STREAMER_RUNTIME:-node}" in
	node)
		exec node --import tsx "$@"
		;;
	bun)
		exec bun "$@"
		;;
	*)
		echo "[run-ts] unknown STREAMER_RUNTIME: ${STREAMER_RUNTIME} (use bun or node)" >&2
		exit 1
		;;
esac
