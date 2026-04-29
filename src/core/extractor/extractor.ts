/**
 * Generic, YAML-driven slot extractor.
 *
 * Replaces the per-topic `streamExtractFlightSlots` / `streamExtractTrainSlots`
 * with a single function that derives both its prompt AND its Zod
 * validation schema from a topic's slot definitions in `agent.yaml`.
 *
 * Output shape matches the spec (§6.4):
 *   { reasoning, updated_slots, ready_to_book, abandon }
 */

import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ConvographConfig, Slot, Topic } from "../config";
import { streamStructured, type UsageInfo } from "../llm";

/* ──────────────────────────────────────────────────────────────────────── */
/* Public types                                                              */
/* ──────────────────────────────────────────────────────────────────────── */

export type SlotValue = string | number | boolean;
export type SlotMap = Record<string, SlotValue | undefined>;

export interface ExtractionResult {
  reasoning: string;
  updated_slots: SlotMap;
  ready_to_book: boolean;
  abandon: boolean;
}

export type PartialExtraction = Partial<ExtractionResult>;

export interface ExtractMessage {
  role: "user" | "agent";
  content: string;
}

export interface ExtractSlotsOptions {
  config: ConvographConfig;
  topicName: string;
  history: ExtractMessage[];
  currentDraft: SlotMap;
  model: LanguageModel;
  /**
   * Provider name for response_format hint; same value passed to
   * createOpenAICompatible (e.g. "nvidia").
   */
  jsonModeProvider?: string;
  /** Called once after the LLM call finishes, with token usage. */
  onUsage?: (usage: UsageInfo) => void;
  /** Override the recent-history window. Default 10 turns. */
  historyWindow?: number;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Slot → Zod schema                                                         */
/* ──────────────────────────────────────────────────────────────────────── */

function zodForSlot(slot: Slot): z.ZodTypeAny {
  switch (slot.type) {
    case "string":
    case "date":
    case "time":
    case "datetime":
    case "email":
    case "phone":
    case "url":
      return z.string();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "enum":
      // schema validation guarantees `values` is non-empty for enum slots.
      return z.enum(slot.values as [string, ...string[]]);
  }
}

/**
 * Build a Zod object schema where every slot is optional (the LLM only
 * emits slots it learned this turn).
 */
function buildUpdatedSlotsSchema(
  topic: Topic
): z.ZodObject<Record<string, z.ZodOptional<z.ZodTypeAny>>> {
  const shape: Record<string, z.ZodOptional<z.ZodTypeAny>> = {};
  for (const slot of topic.slots) {
    shape[slot.name] = zodForSlot(slot).optional();
  }
  return z.object(shape);
}

function buildExtractionSchema(topic: Topic) {
  return z.object({
    reasoning: z.string(),
    updated_slots: buildUpdatedSlotsSchema(topic).default({}),
    ready_to_book: z.boolean(),
    abandon: z.boolean(),
  });
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Prompt construction                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

function describeSlot(slot: Slot): string {
  const parts: string[] = [`  - ${slot.name} (${slot.type}`];
  if (slot.required) parts[0] += ", required";
  if (slot.type === "enum" && slot.values?.length) {
    parts[0] += `, one of: ${slot.values.join(" | ")}`;
  }
  parts[0] += ")";
  if (slot.description) parts.push(`    ${slot.description}`);
  if (slot.default !== undefined) {
    parts.push(`    default: ${JSON.stringify(slot.default)}`);
  }
  if (slot.min !== undefined || slot.max !== undefined) {
    const r = `range: ${slot.min ?? "-"}..${slot.max ?? "-"}`;
    parts.push(`    ${r}`);
  }
  return parts.join("\n");
}

function buildSlotCatalog(topic: Topic): string {
  if (topic.slots.length === 0) return "(this topic has no slots)";
  return topic.slots.map(describeSlot).join("\n");
}

function buildExtractorSystemPrompt(topic: Topic): string {
  const catalog = buildSlotCatalog(topic);
  const slotKeys = topic.slots.map((s) => s.name);
  const updatedSlotsExample =
    slotKeys.length > 0
      ? slotKeys
          .map((n) => `    "${n}"?: ...`)
          .join(",\n")
      : "    /* no slots */";

  return `You are the slot-extraction component of a "${topic.name}" assistant.

Your only job: look at the conversation and the current slot state, and emit
a JSON payload describing what changed. You do NOT produce a user-facing reply.

Slots for this topic:
${catalog}

You MUST respond with a single valid JSON object and nothing else — no
markdown fences, no commentary, no preamble. Output the fields in EXACTLY
this order so the reader sees your reasoning before your slot decisions:

{
  "reasoning": "one short sentence",
  "updated_slots": {
${updatedSlotsExample}
  },
  "ready_to_book": boolean,
  "abandon": boolean
}

Rules:
1. Put NEW or CORRECTED slot values in "updated_slots". Only include fields
   the user mentioned or strongly implied this turn. Omit fields they did
   not say.
2. Use ISO format YYYY-MM-DD for date slots. Interpret natural language
   like "May 10" as the next occurrence of that date.
3. Set "ready_to_book" = true ONLY when all required slots will be filled
   after the updates AND the user's latest message is a clear affirmation
   ("yes", "confirm", "go ahead", "对", "确认", "好的下单" etc.).
4. Set "abandon" = true if the user cancels ("never mind", "cancel", "stop",
   "算了", "取消"). When abandoning, do not set updated_slots.
5. NEVER invent slot values the user did not provide.
6. "reasoning" is one short sentence explaining what you concluded.
`;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Public API                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Stream-extract slots for the given topic. Yields progressively more
 * complete extractions; final returned value is the schema-validated
 * full result.
 *
 * Mirrors the AsyncGenerator contract used by the streamStructured helper.
 */
export async function* extractSlots(
  opts: ExtractSlotsOptions
): AsyncGenerator<PartialExtraction, ExtractionResult, void> {
  const topic = opts.config.topics.find((t) => t.name === opts.topicName);
  if (!topic) {
    throw new Error(
      `extractSlots: topic "${opts.topicName}" not found in config.topics`
    );
  }

  const window = opts.historyWindow ?? 10;
  const recent = opts.history.slice(-window);
  const transcript = recent
    .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${m.content}`)
    .join("\n");

  const draftStr = JSON.stringify(opts.currentDraft, null, 2);
  const schema = buildExtractionSchema(topic);
  const system = buildExtractorSystemPrompt(topic);

  try {
    const inner = streamStructured({
      model: opts.model,
      schema,
      system,
      prompt: `Current draft (slots filled so far):\n${draftStr}\n\nRecent conversation:\n${transcript}\n\nRespond with the JSON object only.`,
      temperature: 0.0,
      jsonModeProvider: opts.jsonModeProvider,
      onUsage: opts.onUsage,
    });

    while (true) {
      const step = await inner.next();
      if (step.done) {
        const v = step.value as z.infer<typeof schema>;
        return {
          reasoning: v.reasoning,
          updated_slots: v.updated_slots as SlotMap,
          ready_to_book: v.ready_to_book,
          abandon: v.abandon,
        };
      }
      const partial = step.value as Partial<z.infer<typeof schema>>;
      yield {
        reasoning: partial.reasoning,
        updated_slots: partial.updated_slots as SlotMap | undefined,
        ready_to_book: partial.ready_to_book,
        abandon: partial.abandon,
      };
    }
  } catch (err) {
    const fallback: ExtractionResult = {
      reasoning: `Extractor error: ${err instanceof Error ? err.message : String(err)}`,
      updated_slots: {},
      ready_to_book: false,
      abandon: false,
    };
    yield fallback;
    return fallback;
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Slot-completeness helpers                                                 */
/* ──────────────────────────────────────────────────────────────────────── */

export function requiredSlotNames(topic: Topic): string[] {
  return topic.slots.filter((s) => s.required).map((s) => s.name);
}

export function firstMissingSlot(topic: Topic, draft: SlotMap): string | null {
  for (const name of requiredSlotNames(topic)) {
    const v = draft[name];
    if (v === undefined || v === null || v === "") return name;
  }
  return null;
}

export function isDraftComplete(topic: Topic, draft: SlotMap): boolean {
  return firstMissingSlot(topic, draft) === null;
}

/* Exposed for tests/inspection. */
export const __internals = {
  buildExtractionSchema,
  buildExtractorSystemPrompt,
  buildSlotCatalog,
  zodForSlot,
};
