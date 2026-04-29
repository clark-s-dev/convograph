/**
 * Generic, YAML-driven reply generator.
 *
 * Replaces the per-topic `streamFlightReply` / `streamTrainReply` with a
 * single function that produces a streamed `{reasoning, reply}` JSON
 * response for any topic in `agent.yaml`.
 *
 * Intent kinds match SPEC §6.1 (ask_slot / confirm / execute / abandon).
 * The smalltalk path is NOT handled here — that goes through a separate
 * `reply_generic` node with its own prompt.
 */

import { streamText, parsePartialJson, type LanguageModel } from "ai";
import type { Topic } from "../config";
import type { UsageInfo } from "../llm";
import type { SlotMap } from "../extractor";

/* ──────────────────────────────────────────────────────────────────────── */
/* Public types                                                              */
/* ──────────────────────────────────────────────────────────────────────── */

export type ReplyIntent =
  | {
      kind: "ask_slot";
      slot: string;
      /** Optional human-readable phrasing hint pulled from YAML. */
      slotDescription?: string;
    }
  | { kind: "confirm"; draft: SlotMap }
  | { kind: "execute_success"; draft: SlotMap; result: unknown }
  | { kind: "abandon" };

export interface ReplyMessage {
  role: "user" | "agent";
  content: string;
}

export interface StreamReplyOptions {
  topic: Topic;
  history: ReplyMessage[];
  draft: SlotMap;
  intent: ReplyIntent;
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
  /** Sampling temperature for the reply call. Default 0.4. */
  temperature?: number;
}

/** Streamed events split into reasoning vs. reply text. */
export type ReplyStreamEvent =
  | { type: "reasoning_delta"; delta: string }
  | { type: "reply_delta"; delta: string };

/* ──────────────────────────────────────────────────────────────────────── */
/* Prompt construction                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

function buildReplySystemPrompt(topic: Topic): string {
  return `You are the conversational voice of a "${topic.name}" assistant.
Topic description: ${topic.description}

You will be told what to convey (the "intent"). Convert it into a short
user-facing reply, and put your internal reasoning in a separate field.

You MUST respond with a single valid JSON object and nothing else — no
markdown fences, no commentary, no preamble. Output the fields in EXACTLY
this order:

{
  "reasoning": "1-2 short sentences explaining how you interpret the intent and any subtle decisions",
  "reply": "the user-facing message — 1-2 short sentences MAXIMUM, conversational and direct"
}

ABSOLUTE RULES FOR THE "reply" FIELD:
- 1-2 sentences MAXIMUM. Never exceed this.
- DO NOT include reasoning, internal notes, parentheticals, or "I think...".
- DO NOT mention "intent", "JSON", "system", "prompt", or anything internal.
- DO NOT discuss alternative interpretations. Pick one and act on it.
- DO NOT hedge or ask the user to choose between interpretations
  (unless intent.kind = "ask_slot", which IS a question).
- Conversational, friendly, direct. The user must never see the words
  "intent", "reference number", "oversight", "interpretation", or
  "reasoning" inside this field.

If the intent looks contradictory or buggy, simply act on it as written
in the "reply" and put your concerns into "reasoning". Do NOT lecture
the user about the apparent bug.

Examples:
{"reasoning":"Need destination next.","reply":"Where would you like to go?"}
{"reasoning":"All required slots filled, asking user to confirm before action.","reply":"Booking confirmed details on screen — want me to proceed?"}
{"reasoning":"Action executed, share confirmation reference.","reply":"Done! Confirmation: BK-A3F2C9. Anything else?"}
{"reasoning":"User cancelled, acknowledge politely.","reply":"OK, cancelled. Let me know if you'd like to try again."}
`;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Public API                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Stream-generate a topic reply. Yields incremental reasoning and reply
 * deltas; consumer accumulates whichever stream it cares about.
 *
 * Final fallback: if the model never emits parseable JSON, the whole
 * accumulated text is yielded as one `reply_delta` so the user always
 * sees something.
 */
export async function* streamReply(
  opts: StreamReplyOptions
): AsyncGenerator<ReplyStreamEvent, void, unknown> {
  const window = opts.historyWindow ?? 10;
  const recent = opts.history.slice(-window);
  const transcript = recent
    .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${m.content}`)
    .join("\n");

  const intentStr = JSON.stringify(opts.intent, null, 2);
  const draftStr = JSON.stringify(opts.draft, null, 2);

  const providerOptions = opts.jsonModeProvider
    ? {
        [opts.jsonModeProvider]: {
          response_format: { type: "json_object" },
          stream_options: { include_usage: true },
        },
      }
    : undefined;

  const result = streamText({
    model: opts.model,
    system: buildReplySystemPrompt(opts.topic),
    prompt: `Recent conversation:\n${transcript}\n\nCurrent draft:\n${draftStr}\n\nIntent to convey:\n${intentStr}\n\nRespond with the JSON object only.`,
    temperature: opts.temperature ?? 0.4,
    providerOptions,
  });

  let accumulated = "";
  let lastReasoning = "";
  let lastReply = "";

  try {
    for await (const delta of result.textStream) {
      accumulated += delta;
      const parsed = await parsePartialJson(accumulated);
      if (
        (parsed.state === "successful-parse" ||
          parsed.state === "repaired-parse") &&
        parsed.value &&
        typeof parsed.value === "object" &&
        !Array.isArray(parsed.value)
      ) {
        const v = parsed.value as { reasoning?: string; reply?: string };
        if (typeof v.reasoning === "string" && v.reasoning !== lastReasoning) {
          const newPart = v.reasoning.slice(lastReasoning.length);
          if (newPart) yield { type: "reasoning_delta", delta: newPart };
          lastReasoning = v.reasoning;
        }
        if (typeof v.reply === "string" && v.reply !== lastReply) {
          const newPart = v.reply.slice(lastReply.length);
          if (newPart) yield { type: "reply_delta", delta: newPart };
          lastReply = v.reply;
        }
      }
    }
  } catch (err) {
    yield {
      type: "reply_delta",
      delta: `Sorry, something went wrong generating the reply. (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  if (lastReply === "" && lastReasoning === "" && accumulated.trim()) {
    yield { type: "reply_delta", delta: accumulated };
  }

  if (opts.onUsage) {
    try {
      const u = await result.usage;
      opts.onUsage({
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        totalTokens: u.totalTokens ?? 0,
      });
    } catch (err) {
      console.warn(
        "[convograph streamReply] usage capture failed:",
        err instanceof Error ? err.message : err
      );
    }
  }
}

/* Exposed for tests/inspection. */
export const __internals = {
  buildReplySystemPrompt,
};
