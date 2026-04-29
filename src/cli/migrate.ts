/**
 * `convograph migrate`
 *
 * Loads agent.yaml + DATABASE_URL, applies pending DB migrations
 * idempotently. Output is printed; an exception is thrown on failure
 * so the dispatcher can exit non-zero.
 */

import { Pool } from "pg";
import { loadConfig } from "../core/config";
import { runMigrations } from "../core/persistence";

export interface MigrateArgs {
  yamlPath?: string;
  dryRun?: boolean;
}

export async function runMigrate(args: MigrateArgs = {}): Promise<void> {
  const cfg = loadConfig(args.yamlPath ?? "./agent.yaml");

  console.log(
    `[convograph migrate] config: ${cfg.name} v${cfg.version}; schema=${cfg.database.schema}`
  );

  const pool = new Pool({ connectionString: cfg.database.url });
  try {
    const result = await runMigrations({
      pool,
      schema: cfg.database.schema,
      dryRun: args.dryRun ?? false,
    });
    console.log(`\n[convograph migrate] done.`);
    console.log(
      `  applied:        ${result.applied.length} (${result.applied.join(", ") || "—"})`
    );
    console.log(
      `  already applied: ${result.alreadyApplied.length} (${result.alreadyApplied.join(", ") || "—"})`
    );
  } finally {
    await pool.end();
  }
}
