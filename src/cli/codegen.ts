/**
 * `convograph codegen`
 *
 * Reads agent.yaml, produces lib/convograph/generated/types.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../core/config";
import { generateTypes } from "../codegen";

export interface CodegenArgs {
  yamlPath?: string;
  /** Directory to write generated/ into. Default: same dir as yaml. */
  outDir?: string;
}

export async function runCodegen(args: CodegenArgs = {}): Promise<void> {
  const yamlPath = path.resolve(args.yamlPath ?? "./agent.yaml");
  const cfg = loadConfig(yamlPath);

  const output = generateTypes(cfg, {
    sourceFile: path.relative(".", yamlPath),
  });

  const outDir = path.resolve(
    args.outDir ?? "./lib/convograph/generated"
  );
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "types.ts");
  fs.writeFileSync(outFile, output);

  console.log(
    `[convograph codegen] wrote ${path.relative(".", outFile)} — ${cfg.topics.length} topic(s)`
  );
  for (const topic of cfg.topics) {
    console.log(`  ${topic.name}: ${topic.slots.length} slot(s)`);
  }
}
