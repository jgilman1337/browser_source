#!/bin/sh
# Run TypeScript under Bun (preferred) or Node via tsx.
# Override with STREAMER_RUNTIME=bun|node for Docker images that ship only one runtime.
set -e

run_bun() {
	exec bun "$@"
}

run_node() {
	exec npx tsx "$@"
}

if [ -n "${STREAMER_RUNTIME:-}" ]; then
	case "${STREAMER_RUNTIME}" in
		bun) run_bun "$@" ;;
		node) run_node "$@" ;;
		*)
			echo "[run-ts] unknown STREAMER_RUNTIME: ${STREAMER_RUNTIME} (use bun or node)" >&2
			exit 1
			;;
	esac
fi

if command -v bun >/dev/null 2>&1; then
	run_bun "$@"
fi

if command -v npx >/dev/null 2>&1; then
	run_node "$@"
fi

echo "[run-ts] need bun or npx (tsx) on PATH" >&2
exit 1
