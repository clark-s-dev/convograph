/**
 * Postgres connection management for convograph.
 *
 * Two ways to get a Pool:
 *   1. injected from the host project (preferred — convograph reuses the
 *      caller's existing pool, no extra connection slots used)
 *   2. created from a connection string in the YAML config
 *
 * Either way, callers go through getPool(opts) so the rest of convograph
 * doesn't care which path was taken.
 */

import { Pool, type PoolConfig } from "pg";

export interface ConnectionOptions {
  /** A Pool created elsewhere — we'll just use it. */
  pool?: Pool;
  /** Or a connection string we'll create our own pool from. */
  connectionString?: string;
  /** Additional pg pool options when creating a new pool. */
  poolConfig?: Omit<PoolConfig, "connectionString">;
}

/**
 * Returns a Pool. If `opts.pool` is provided, returns it as-is. Otherwise
 * creates a new pool from `connectionString` + `poolConfig`.
 *
 * Callers SHOULD reuse the returned pool across requests. Don't call
 * end() unless you own it.
 */
export function getPool(opts: ConnectionOptions): Pool {
  if (opts.pool) return opts.pool;
  if (!opts.connectionString) {
    throw new Error(
      "[convograph] getPool() requires either an existing Pool or a connectionString."
    );
  }
  return new Pool({
    connectionString: opts.connectionString,
    // Sane defaults — adjust as needed
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...opts.poolConfig,
  });
}
