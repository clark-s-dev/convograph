/**
 * `convograph validate [yaml-path]`
 *
 * Loads, parses, and Zod-validates the YAML config. Prints a structured
 * error if invalid; exits with code 1.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
  loadConfig,
  isConvographConfigError,
  isConvographYamlSyntaxError,
} from "../core/config";

export interface ValidateArgs {
  yamlPath?: string;
}

export interface ValidateResult {
  ok: boolean;
  message: string;
}

export async function runValidate(
  args: ValidateArgs = {}
): Promise<ValidateResult> {
  const yamlPath = path.resolve(args.yamlPath ?? "./agent.yaml");

  if (!fs.existsSync(yamlPath)) {
    return {
      ok: false,
      message: `[convograph validate] file not found: ${yamlPath}`,
    };
  }

  try {
    const cfg = loadConfig(yamlPath);
    const lines = [
      `[convograph validate] ${path.relative(".", yamlPath)} is valid`,
      `  name:    ${cfg.name} v${cfg.version}`,
      `  topics:  ${cfg.topics.length}`,
    ];
    for (const t of cfg.topics) {
      const slotInfo = t.slots.length === 0 ? "no slots" : `${t.slots.length} slot(s)`;
      lines.push(`    - ${t.name} (${slotInfo})`);
    }
    return { ok: true, message: lines.join("\n") };
  } catch (err) {
    if (isConvographConfigError(err)) {
      return { ok: false, message: err.format() };
    }
    if (isConvographYamlSyntaxError(err)) {
      return { ok: false, message: `[convograph validate] ${err.message}` };
    }
    return {
      ok: false,
      message: `[convograph validate] unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
