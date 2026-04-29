/**
 * YAML config loader for convograph.
 *
 * Pipeline:
 *   1. Read file (or accept raw string)
 *   2. Expand ${ENV_VAR} references against process.env
 *   3. Parse YAML
 *   4. Validate against Zod schema
 *   5. Return typed ConvographConfig, or throw ConvographConfigError
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import { configSchema, type ConvographConfig } from "./schema";
import {
  ConvographConfigError,
  ConvographYamlSyntaxError,
  fromZodError,
} from "./errors";

/* ──────────────────────────────────────────────────────────────────────── */
/* Environment-variable interpolation                                        */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Expands ${ENV_VAR} references in the YAML source text.
 *
 * Two forms are supported:
 *   ${VAR}            — required; throws if VAR is unset
 *   ${VAR:-fallback}  — optional; uses fallback if VAR is unset
 *
 * Done as a string-level transform BEFORE YAML parsing so that quoted
 * values still work and the resulting YAML is valid for any string content.
 *
 * Note: only expands within YAML scalar contexts. Multi-line literals
 * (using | or >) work fine since this is just regex substitution.
 */
export function expandEnvVars(
  source: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const pattern = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi;
  const missing: string[] = [];

  const result = source.replace(pattern, (_match, varName, fallback) => {
    const v = env[varName];
    if (v !== undefined && v !== "") return v;
    if (fallback !== undefined) return fallback;
    missing.push(varName);
    return "";
  });

  if (missing.length > 0) {
    throw new ConvographYamlSyntaxError(
      `agent.yaml references undefined environment variable(s): ${missing
        .map((v) => `\$\{${v}\}`)
        .join(", ")}. ` +
        `Set them in .env / .env.local, or use \$\{NAME:-default\} syntax.`
    );
  }

  return result;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Public API                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

export interface ParseOptions {
  /**
   * Optional source label for error messages (file path, "stdin", etc.).
   * Set automatically by `loadConfig` from the file path.
   */
  source?: string;
  /**
   * Override process.env for env-var interpolation. Useful for tests.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse a YAML string into a validated ConvographConfig.
 * Throws ConvographConfigError or ConvographYamlSyntaxError on failure.
 */
export function parseConfig(
  yamlText: string,
  opts: ParseOptions = {}
): ConvographConfig {
  const expanded = expandEnvVars(yamlText, opts.env);

  let raw: unknown;
  try {
    raw = parseYaml(expanded);
  } catch (err) {
    throw new ConvographYamlSyntaxError(
      `YAML syntax error: ${err instanceof Error ? err.message : String(err)}`,
      opts.source,
      err
    );
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw fromZodError(parsed.error, opts.source);
  }
  return parsed.data;
}

/**
 * Read a file, parse, validate. Convenience wrapper around parseConfig.
 */
export function loadConfig(
  yamlPath: string,
  opts: Omit<ParseOptions, "source"> = {}
): ConvographConfig {
  const abs = path.resolve(yamlPath);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf-8");
  } catch (err) {
    throw new ConvographYamlSyntaxError(
      `Could not read agent.yaml at ${abs}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      abs,
      err
    );
  }
  return parseConfig(text, { ...opts, source: abs });
}

/** Type guard to distinguish convograph config errors from other errors. */
export function isConvographConfigError(
  err: unknown
): err is ConvographConfigError {
  return err instanceof ConvographConfigError;
}

/** Type guard for YAML syntax / file IO errors. */
export function isConvographYamlSyntaxError(
  err: unknown
): err is ConvographYamlSyntaxError {
  return err instanceof ConvographYamlSyntaxError;
}
