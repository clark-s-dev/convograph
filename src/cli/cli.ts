/**
 * convograph CLI dispatcher.
 *
 * Subcommands:
 *   validate [path]    Validate an agent.yaml (default: ./agent.yaml).
 *   migrate            Apply pending DB migrations (idempotent).
 *   codegen            Regenerate TypeScript types from agent.yaml.
 *   help               Show this message.
 *
 * Designed to be invoked as a top-level binary (`convograph <cmd>`)
 * once published. In-tree, run via `npm run convograph -- <cmd>`.
 *
 * Returns exit code 0 on success, 1 on usage error or command failure.
 */

import { runValidate } from "./validate";
import { runMigrate } from "./migrate";
import { runCodegen } from "./codegen";
import {
  isConvographConfigError,
  isConvographYamlSyntaxError,
} from "../core/config";

const HELP = `convograph — manage your YAML-driven agent

USAGE
  convograph <command> [options]

COMMANDS
  validate [yaml-path]     Lint an agent.yaml (default: ./agent.yaml)
  migrate                  Apply pending DB migrations (idempotent)
  codegen                  Regenerate TypeScript types from agent.yaml
  help                     Show this help

OPTIONS (per-command)
  validate [yaml-path]
  migrate [--yaml <path>] [--dry-run]
  codegen [--yaml <path>] [--out-dir <path>]

EXAMPLES
  convograph validate
  convograph migrate
  convograph migrate --dry-run
  convograph codegen
  convograph codegen --yaml ./other.yaml --out-dir ./generated
`;

/* ──────────────────────────────────────────────────────────────────────── */
/* Tiny argv parser — no third-party dep. Sufficient for these flags.      */
/* ──────────────────────────────────────────────────────────────────────── */

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Public entry point                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return command ? 0 : 1;
  }

  const { positional, flags } = parseArgs(rest);

  try {
    switch (command) {
      case "validate": {
        const result = await runValidate({
          yamlPath: positional[0] ?? (flags.yaml as string | undefined),
        });
        console.log(result.message);
        return result.ok ? 0 : 1;
      }
      case "migrate": {
        await runMigrate({
          yamlPath: flags.yaml as string | undefined,
          dryRun: flags["dry-run"] === true,
        });
        return 0;
      }
      case "codegen": {
        await runCodegen({
          yamlPath: flags.yaml as string | undefined,
          outDir: flags["out-dir"] as string | undefined,
        });
        return 0;
      }
      default: {
        console.error(`Unknown command: ${command}`);
        console.error(HELP);
        return 1;
      }
    }
  } catch (err) {
    if (isConvographConfigError(err)) {
      console.error(err.format());
    } else if (isConvographYamlSyntaxError(err)) {
      console.error(`[convograph] ${err.message}`);
    } else {
      console.error(
        `[convograph] error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return 1;
  }
}
