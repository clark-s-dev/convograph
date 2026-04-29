/**
 * Streaming structured-JSON helper.
 *
 * Drives a streamText call against a chat-completion model with
 * response_format=json_object, parses partial JSON on each chunk, and
 * yields successively-more-complete snapshots of the parsed object.
 *
 * The final return value is the schema-validated full object.
 *
 * Usage:
 *   for await (const partial of streamStructured({...})) {
 *     // emit partial snapshot to UI / shadow DB
 *   }
 *   // returned value (final) is also yielded once at the end via
 *   // generator return semantics — capture via .next() if needed.
 *
 * Or with delegation:
 *   return yield* streamStructured({...});
 */

import {
  streamText,
  parsePartialJson,
  type LanguageModel,
  type JSONValue,
} from "ai";
import type { z } from "zod";

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface StreamStructuredOptions<S extends z.ZodTypeAny> {
  model: LanguageModel;
  schema: S;
  system?: string;
  prompt: string;
  temperature?: number;
  /**
   * Adds `response_format: { type: 'json_object' }` under the given
   * provider key. Most NIM / OpenAI-style endpoints require this for
   * reliable JSON output. Pass the same `name` you used when creating
   * the AI SDK provider (e.g. "nvidia").
   */
  jsonModeProvider?: string;
  /**
   * Extra raw providerOptions to merge on top of the jsonMode default.
   * Useful for passing nvext flags etc.
   */
  providerOptions?: Record<string, Record<string, JSONValue>>;
  /**
   * Called once after the full stream has completed, with token usage
   * reported by the model. Errors in this callback are caught and
   * logged so they can't disrupt the main response path.
   */
  onUsage?: (usage: UsageInfo) => void;
}

/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Best-effort extraction of a JSON object from text that may include
 * stray commentary or markdown fences. Looks for ```json``` fences
 * first, then falls back to the outermost {...} block.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

/* ──────────────────────────────────────────────────────────────────────── */

export async function* streamStructured<S extends z.ZodTypeAny>(
  opts: StreamStructuredOptions<S>
): AsyncGenerator<Partial<z.infer<S>>, z.infer<S>, void> {
  const providerOptions: Record<string, Record<string, JSONValue>> = {};
  if (opts.jsonModeProvider) {
    providerOptions[opts.jsonModeProvider] = {
      response_format: { type: "json_object" },
      // OpenAI-compatible providers (incl. NVIDIA NIM) only emit usage
      // stats in streaming responses when this flag is set.
      stream_options: { include_usage: true },
    };
  }
  if (opts.providerOptions) {
    for (const [k, v] of Object.entries(opts.providerOptions)) {
      providerOptions[k] = { ...(providerOptions[k] ?? {}), ...v };
    }
  }

  const stream = streamText({
    model: opts.model,
    system: opts.system,
    prompt: opts.prompt,
    temperature: opts.temperature ?? 0.0,
    providerOptions:
      Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
  });

  let accumulated = "";
  let lastSerialized = "";

  for await (const delta of stream.textStream) {
    accumulated += delta;
    const result = await parsePartialJson(accumulated);
    if (
      (result.state === "successful-parse" ||
        result.state === "repaired-parse") &&
      result.value &&
      typeof result.value === "object" &&
      !Array.isArray(result.value)
    ) {
      const ser = JSON.stringify(result.value);
      if (ser !== lastSerialized) {
        lastSerialized = ser;
        yield result.value as Partial<z.infer<S>>;
      }
    }
  }

  // Capture token usage for callers that opted in. This resolves once
  // the upstream provider has finished and reported usage stats.
  if (opts.onUsage) {
    try {
      const usage = await stream.usage;
      opts.onUsage({
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
      });
    } catch (err) {
      console.warn(
        "[convograph streamStructured] usage capture failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  // Final parse + Zod validation. If the LLM never produced parseable
  // JSON, this throws — let the caller wrap with their own fallback.
  return opts.schema.parse(JSON.parse(extractJson(accumulated)));
}
