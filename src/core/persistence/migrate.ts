/**
 * Convograph migration runner.
 *
 * - Migrations live as numbered .sql files in ./migrations/.
 * - Each file is templated: {{SCHEMA}} is replaced with the configured
 *   (quote-escaped) schema name at runtime.
 * - Applied migrations are tracked in {schema}._migrations to make the
 *   runner idempotent — running migrate twice is a no-op.
 *
 * v0 keeps things deliberately simple: no rollback, no down-migrations,
 * one-way schema evolution. Add proper down-migrations in v1 if needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Pool } from "pg";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export interface MigrationFile {
  /** Filename without extension, e.g. "001_initial_schema". */
  name: string;
  /** Numeric prefix, parsed from filename, used for ordering. */
  version: number;
  /** Raw SQL content with {{SCHEMA}} placeholders. */
  sql: string;
}

/** Discover .sql files in the migrations directory, sorted by version. */
export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  return entries.map((file) => {
    const name = file.replace(/\.sql$/, "");
    const m = /^(\d+)_/.exec(name);
    if (!m) {
      throw new Error(
        `Migration file ${file} must start with a numeric prefix (e.g. 001_).`
      );
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf-8");
    return { name, version: Number(m[1]), sql };
  });
}

/** Apply the {{SCHEMA}} substitution to migration SQL. */
function applyTemplate(sql: string, schemaIdent: string): string {
  return sql.replace(/\{\{SCHEMA\}\}/g, schemaIdent);
}

/** Quote a schema identifier to be safe in SQL. */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(
      `Refusing to use schema name ${JSON.stringify(name)}: must match [A-Za-z_][A-Za-z0-9_]*`
    );
  }
  return `"${name}"`;
}

export interface RunMigrationsOptions {
  pool: Pool;
  schema: string;
  /** Override migrations directory. Defaults to ./migrations next to this file. */
  migrationsDir?: string;
  /** If true, only print what would be applied — no DB writes. */
  dryRun?: boolean;
  /** Logger. Defaults to console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface MigrationResult {
  schema: string;
  applied: string[];
  alreadyApplied: string[];
  dryRun: boolean;
}

/**
 * Apply pending migrations against the configured schema.
 * Idempotent — already-applied migrations are skipped.
 */
export async function runMigrations(
  opts: RunMigrationsOptions
): Promise<MigrationResult> {
  const { pool, schema, dryRun = false } = opts;
  const log = opts.logger ?? console;
  const migrations = listMigrations(opts.migrationsDir);
  const ident = quoteIdent(schema);

  log.log(
    `[convograph migrate] target schema: ${ident}; ${migrations.length} migration(s) on disk`
  );

  // Step 1: ensure schema and metadata table exist (always, before listing).
  if (!dryRun) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${ident}`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${ident}._migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  // Step 2: read which versions are already applied.
  let applied: Set<number>;
  if (dryRun) {
    applied = new Set();
  } else {
    const res = await pool.query<{ version: number }>(
      `SELECT version FROM ${ident}._migrations`
    );
    applied = new Set(res.rows.map((r) => r.version));
  }

  const result: MigrationResult = {
    schema,
    applied: [],
    alreadyApplied: [],
    dryRun,
  };

  // Step 3: run each pending migration in a transaction.
  for (const m of migrations) {
    if (applied.has(m.version)) {
      log.log(`[convograph migrate] skip ${m.name} (already applied)`);
      result.alreadyApplied.push(m.name);
      continue;
    }

    log.log(`[convograph migrate] apply ${m.name}…`);

    if (dryRun) {
      result.applied.push(m.name);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(applyTemplate(m.sql, ident));
      await client.query(
        `INSERT INTO ${ident}._migrations (version, name) VALUES ($1, $2)`,
        [m.version, m.name]
      );
      await client.query("COMMIT");
      result.applied.push(m.name);
      log.log(`[convograph migrate] applied ${m.name}`);
    } catch (err) {
      await client.query("ROLLBACK");
      log.error(`[convograph migrate] FAILED ${m.name}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  return result;
}
