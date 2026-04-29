/**
 * Generic intent router driven by agent.yaml.
 *
 * The router's topic enum and system prompt come from config, not from
 * hard-coded TypeScript. To add a new topic, just add it to agent.yaml's
 * `topics:` list — the router immediately knows about it.
 *
 * The fallback path (when classification fails) routes to a topic named
 * "smalltalk" if present, otherwise to the first topic in the config.
 */

import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ConvographConfig } from "../config";
import { streamStructured, type UsageInfo } from "../llm";

export interface RouterDecision {
  /** One of the topic names from config.topics. */
  topic: string;
  /** Model's confidence in the classification, 0..1. */
  confidence: number;
  /** Short explanation of the routing decision. */
  reasoning: string;
}

export type PartialRouterDecision = Partial<RouterDecision>;

export interface ClassifyIntentOptions {
  config: ConvographConfig;
  history: { role: "user" | "agent"; content: string }[];
  model: LanguageModel;
  /**
   * Provider name for response_format hint. Pass the same `name` you used
   * with createOpenAICompatible (e.g. "nvidia").
   */
  jsonModeProvider?: string;
  /** Called once after the LLM call finishes, with token usage. */
  onUsage?: (usage: UsageInfo) => void;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Default prompt template                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

function buildTopicCatalog(config: ConvographConfig): string {
  return config.topics
    .map((t) => `- "${t.name}": ${t.description}`)
    .join("\n");
}

function buildDefaultRouterPrompt(config: ConvographConfig): string {
  return `You are an intent router.

Classify the user's most recent message into exactly one of these topics:
${buildTopicCatalog(config)}

When the user has an active task in progress and is providing additional
details (e.g. a date, a passenger count, a confirmation), the topic
remains the same as the active task. Use the recent conversation to
disambiguate.

You MUST respond with a single valid JSON object and nothing else — no
markdown fences, no commentary, no preamble. Output the fields in
EXACTLY this order so the reader sees your reasoning before your decision:

{
  "reasoning": "one short sentence explaining your decision",
  "topic": "<one of the topic names listed above>",
  "confidence": <number between 0 and 1>
}`;
}

/**
 * If the user supplied a custom prompt in agent.yaml, we still need to
 * inject the canonical topic list so the LLM knows the exact allowed
 * topic ids. Appended as a separate section so the user's intro voice
 * is preserved.
 */
function buildEffectiveRouterPrompt(config: ConvographConfig): string {
  if (!config.router.prompt) return buildDefaultRouterPrompt(config);

  return `${config.router.prompt.trim()}

═══════════════════════════════════════════════════════════════════
The "topic" field MUST be EXACTLY one of these literal strings — do
NOT use any other value, do NOT abbreviate, do NOT translate:

${buildTopicCatalog(config)}

Output a single JSON object with this shape:
{
  "reasoning": "<one short sentence>",
  "topic": "<one of the topic names above, verbatim>",
  "confidence": <number between 0 and 1>
}`;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Public API                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

export async function* streamClassifyIntent(
  opts: ClassifyIntentOptions
): AsyncGenerator<PartialRouterDecision, RouterDecision, void> {
  const { config, history, model, jsonModeProvider, onUsage } = opts;
  const topicNames = config.topics.map((t) => t.name);

  if (topicNames.length === 0) {
    throw new Error(
      "[convograph router] cannot classify: agent.yaml has no topics."
    );
  }

  const systemPrompt = buildEffectiveRouterPrompt(config);

  const decisionSchema = z.object({
    reasoning: z.string(),
    topic: z.enum(topicNames as [string, ...string[]]),
    confidence: z.number().min(0).max(1),
  });

  const recent = history.slice(-6);
  const transcript = recent
    .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${m.content}`)
    .join("\n");

  try {
    return yield* streamStructured({
      model,
      schema: decisionSchema,
      system: systemPrompt,
      prompt: `Recent conversation:\n${transcript}\n\nRespond with the JSON object only.`,
      temperature: 0.0,
      jsonModeProvider,
      onUsage,
    });
  } catch (err) {
    // Fallback to "smalltalk" if defined, else the first topic in the
    // config. Confidence 0 lets the host code decide whether to clarify.
    const fallbackTopic =
      topicNames.find((t) => t === "smalltalk") ?? topicNames[0];
    const fallback: RouterDecision = {
      topic: fallbackTopic,
      confidence: 0.0,
      reasoning: `Router error: ${err instanceof Error ? err.message : String(err)}`,
    };
    yield fallback;
    return fallback;
  }
}
