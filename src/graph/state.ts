/**
 * State channels for the convograph subgraph.
 *
 * Internal channels are `_convograph_*` namespaced per SPEC §6.2 so a host
 * graph that embeds the subgraph never collides on channel names.
 */

import { Annotation } from "@langchain/langgraph";
import type { RouterDecision } from "../core/router";
import type { ExtractionResult, SlotMap } from "../core/extractor";
import type { ReplyIntent } from "../core/reply";

/* ──────────────────────────────────────────────────────────────────────── */
/* Public-facing types                                                      */
/* ──────────────────────────────────────────────────────────────────────── */

export interface ChatTurn {
  role: "user" | "agent";
  content: string;
}

export interface ConvographOutputState {
  /** Topic the router classified this turn into. */
  topic: string;
  /** Confidence the router reported. */
  confidence: number;
  /** Latest slot snapshot after this turn. Empty for non-task topics. */
  slots: SlotMap;
  /** True iff a draft was sealed this turn (action ran successfully). */
  sealed: boolean;
  /** Action handler's return value, if it ran. */
  actionResult?: unknown;
  /** True iff the user abandoned the active draft. */
  abandoned: boolean;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Subgraph state                                                            */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Single annotation root holding both public input/output channels and
 * convograph-internal scratch channels (prefixed `_convograph_`).
 */
export const SubgraphState = Annotation.Root({
  /* ── input ── */
  threadId: Annotation<string>,
  userId: Annotation<string>,
  userMessage: Annotation<string>,

  /* ── output ── */
  agentReply: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  convograph: Annotation<ConvographOutputState>({
    reducer: (_prev, next) => next,
    default: () =>
      ({
        topic: "",
        confidence: 0,
        slots: {},
        sealed: false,
        abandoned: false,
      }) satisfies ConvographOutputState,
  }),

  /* ── internal scratch (per-turn) ── */
  /** Conversation history (most recent N turns). The host primes this. */
  _convograph_history: Annotation<ChatTurn[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /** Router's structured decision for this turn. */
  _convograph_intentDecision: Annotation<RouterDecision | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Active draft's slots BEFORE this turn's extraction. */
  _convograph_slotsBefore: Annotation<SlotMap>({
    reducer: (_prev, next) => next,
    default: () => ({}),
  }),
  /** Active draft's slots AFTER this turn's extraction + commit. */
  _convograph_slotsAfter: Annotation<SlotMap>({
    reducer: (_prev, next) => next,
    default: () => ({}),
  }),
  /** Extractor's structured output. */
  _convograph_extractionResult: Annotation<ExtractionResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** What the reply node should convey. */
  _convograph_replyIntent: Annotation<ReplyIntent | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Set when the action handler ran successfully. */
  _convograph_actionResult: Annotation<unknown>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
});

export type SubgraphStateType = typeof SubgraphState.State;
export type SubgraphUpdate = typeof SubgraphState.Update;
