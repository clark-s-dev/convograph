/**
 * Public entry point for convograph (in-tree).
 *
 * Re-exports universal-safe modules. Server-only modules (persistence,
 * future migration runner, etc.) MUST be imported directly from their
 * subpath, e.g. `import * as persistence from "@/lib/convograph/core/persistence"`.
 *
 * Why: this index is reachable from client component import chains, and
 * leaking server-only Node modules (node:fs, pg) into the client bundle
 * crashes the build.
 */

export * as config from "./core/config";
export * as router from "./core/router";
export * as extractor from "./core/extractor";
export * as reply from "./core/reply";
