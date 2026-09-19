/**
 * Cross-runtime helpers for Bun and Node.
 *
 * Application code should import file I/O from `./fs` (node:fs/promises — works on both).
 * Shell entrypoints should use `scripts/run-ts.sh` with an explicit STREAMER_RUNTIME.
 */

/** Supported JavaScript runtimes. */
export type RuntimeName = "bun" | "node";

/** Minimal Bun global shape — avoids requiring bun-types when typechecking under Node. */
type BunGlobal = {
	version: string;
};

function detectBun(): BunGlobal | undefined {
	return (globalThis as { Bun?: BunGlobal }).Bun;
}

/** Active runtime, resolved once at module load. */
export const runtimeName: RuntimeName = detectBun() !== undefined ? "bun" : "node";

/** True when running under Bun. */
export function isBun(): boolean {
	return runtimeName === "bun";
}

/** True when running under Node. */
export function isNode(): boolean {
	return runtimeName === "node";
}

/** `bun run` or `npm run` — for user-facing error messages. */
export function packageManagerRun(): string {
	return isBun() ? "bun run" : "npm run";
}
