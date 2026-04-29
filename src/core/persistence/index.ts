/**
 * Public surface of the persistence module.
 */

export {
  runMigrations,
  listMigrations,
  type RunMigrationsOptions,
  type MigrationResult,
  type MigrationFile,
} from "./migrate";

export { getPool, type ConnectionOptions } from "./connection";

export { PersistenceAdapter } from "./adapter";

export type {
  ThreadRow,
  MessageRow,
  DraftRow,
  CompletedTaskRow,
  UserPreferenceRow,
} from "./types";
