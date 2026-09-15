/**
 * Cross-runtime file I/O.
 *
 * Bun implements Node's `node:fs/promises` API — use this module everywhere instead of
 * Bun-specific file APIs so the same source runs under Node and Bun.
 */
export { access, readFile, writeFile } from "node:fs/promises";
