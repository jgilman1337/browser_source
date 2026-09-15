/**
 * Cross-runtime file I/O.
 *
 * Bun implements Node's `node:fs/promises` API — use this module everywhere instead of
 * Bun-specific file APIs so `master` patches apply cleanly to `node`.
 */
export { access, readFile, writeFile } from "node:fs/promises";
