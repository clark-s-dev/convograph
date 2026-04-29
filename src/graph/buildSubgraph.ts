/**
 * `buildSubgraph()` — primary entry point for embedding convograph into a
 * host LangGraph project.
 *
 * Topology (merged-reply variant of SPEC §6.1):
 *
 *   START
 *     │
 *     ▼
 *   load_thread
 *     │
 *     ▼
 *   classify_intent ──► route_decision ─── "smalltalk" ──► reply_generic ──► END
 *     │
 *     └── task topic ──► sync_draft ──► extract_slots ──► commit_slots ──►
 *                          decide_action ─── "execute" ──► execute_action ──► seal_draft ──► reply ──► END
 *                                       └── ask_slot/confirm/abandon ──► reply ──► END
 *
 * The four reply branches in SPEC §6.1 are collapsed into a single
 * intent-driven `reply` node. The subgraph publishes the discrete state
 * (ask_slot / confirm / execute_success / abandon) on `_convograph_replyIntent`.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { streamText, type LanguageModel } from "ai";

import type { ConvographConfig, Topic } from "../core/config";
import { streamClassifyIntent, type RouterDecision } from "../core/router";
import {
  extractSlots,
  firstMissingSlot,
  isDraftComplete,
  type SlotMap,
  type ExtractionResult,
} from "../core/extractor";
import { streamReply, type ReplyIntent } from "../core/reply";
import type { UsageInfo } from "../core/llm";

import {
  SubgraphState,
  type ChatTurn,
  type ConvographOutputState,
} from "./state";

/* ──────────────────────────────────────────────────────────────────────── */
/* Public types                                                              */
/* ──────────────────────────────────────────────────────────────────────── */

export interface DraftAdapter {
  /**
   * Load (or lazily create) the active draft for `(threadId, topic)`.
   * Should return the slot map, or {} if no draft exists yet.
   */
  load(threadId: string, topic: string): Promise<SlotMap>;
  /** Persist the merged slot map for the active draft. */
  save(threadId: string, topic: string, slots: SlotMap): Promise<void>;
  /** Mark the draft as completed, recording the action's result. */
  seal(
    threadId: string,
    topic: string,
    finalSlots: SlotMap,
    actionResult: unknown
  ): Promise<void>;
  /** Mark the draft as abandoned. */
  abandon(threadId: string, topic: string): Promise<void>;
}

export interface HistoryAdapter {
  /** Most recent turns for context (host project decides cap & ordering). */
  load(threadId: string): Promise<ChatTurn[]>;
  /** Append the turn pair for this round. */
  append(threadId: string, userMsg: string, agentReply: string): Promise<void>;
}

export type ActionHandler = (
  draft: SlotMap,
  ctx: { threadId: string; userId: string; topic: string }
) => Promise<unknown>;

export interface BuildSubgraphOptions {
  config: ConvographConfig;
  model: LanguageModel;
  /** Provider name for response_format hint (e.g. "nvidia"). */
  jsonModeProvider?: string;
  /** Per-topic action handlers. Topic missing here ⇒ no execute branch. */
  actions?: Record<string, ActionHandler>;
  /** Required: where drafts live. */
  drafts: DraftAdapter;
  /** Optional: conversation history loader. Defaults to no-op (empty). */
  history?: HistoryAdapter;
  /** Optional callbacks for streaming partial events out of the subgraph. */
  callbacks?: SubgraphCallbacks;
}

export interface SubgraphCallbacks {
  onRouterPartial?: (partial: {
    topic?: string;
    confidence?: number;
    reasoning?: string;
  }) => void;
  onRouterFinal?: (final: {
    topic: string;
    confidence: number;
    reasoning: string;
  }) => void;
  onExtractionPartial?: (
    topic: string,
    slotsBefore: SlotMap,
    partial: {
      reasoning?: string;
      updated_slots?: SlotMap;
      ready_to_book?: boolean;
      abandon?: boolean;
    }
  ) => void;
  onExtractionFinal?: (
    topic: string,
    slotsBefore: SlotMap,
    slotsAfter: SlotMap,
    result: {
      reasoning: string;
      ready_to_book: boolean;
      abandon: boolean;
    }
  ) => void;
  onReplyReasoningDelta?: (delta: string) => void;
  onReplyTextDelta?: (delta: string) => void;
  onActionResult?: (topic: string, result: unknown) => void;
  onUsage?: (kind: "router" | "extractor" | "reply", usage: UsageInfo) => void;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

const SMALLTALK = "smalltalk";

function findTopic(config: ConvographConfig, name: string): Topic | undefined {
  return config.topics.find((t) => t.name === name);
}

function isTaskTopic(config: ConvographConfig, name: string): boolean {
  const t = findTopic(config, name);
  return !!t && t.slots.length > 0;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* buildSubgraph                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

export function buildSubgraph(opts: BuildSubgraphOptions) {
  const cb = opts.callbacks ?? {};
  const historyAdapter: HistoryAdapter =
    opts.history ?? {
      load: async () => [],
      append: async () => {},
    };

  /* ── Nodes ─────────────────────────────────────────────────────────── */

  async function loadThread(state: typeof SubgraphState.State) {
    const history = await historyAdapter.load(state.threadId);
    return { _convograph_history: history };
  }

  async function classifyIntentNode(state: typeof SubgraphState.State) {
    const fullHistory: ChatTurn[] = [
      ...state._convograph_history,
      { role: "user" as const, content: state.userMessage },
    ];
    const inner = streamClassifyIntent({
      config: opts.config,
      history: fullHistory,
      model: opts.model,
      jsonModeProvider: opts.jsonModeProvider,
      onUsage: (u) => cb.onUsage?.("router", u),
    });

    let final: RouterDecision | undefined;
    while (true) {
      const step = await inner.next();
      if (step.done) {
        final = step.value;
        break;
      }
      cb.onRouterPartial?.(step.value);
    }
    if (!final) {
      throw new Error(
        "[convograph] router returned no final decision — should be unreachable"
      );
    }
    cb.onRouterFinal?.(final);
    return { _convograph_intentDecision: final };
  }

  function routeAfterIntent(state: typeof SubgraphState.State) {
    const decision = state._convograph_intentDecision;
    if (!decision) return "reply_generic";
    if (decision.topic === SMALLTALK) return "reply_generic";
    if (isTaskTopic(opts.config, decision.topic)) return "sync_draft";
    return "reply_generic";
  }

  async function syncDraft(state: typeof SubgraphState.State) {
    const topic = state._convograph_intentDecision!.topic;
    const slotsBefore = await opts.drafts.load(state.threadId, topic);
    return { _convograph_slotsBefore: slotsBefore };
  }

  async function extractSlotsNode(state: typeof SubgraphState.State) {
    const topic = state._convograph_intentDecision!.topic;
    const slotsBefore = state._convograph_slotsBefore;
    const fullHistory: ChatTurn[] = [
      ...state._convograph_history,
      { role: "user" as const, content: state.userMessage },
    ];

    const inner = extractSlots({
      config: opts.config,
      topicName: topic,
      history: fullHistory,
      currentDraft: slotsBefore,
      model: opts.model,
      jsonModeProvider: opts.jsonModeProvider,
      onUsage: (u) => cb.onUsage?.("extractor", u),
    });

    let result: ExtractionResult | undefined;
    while (true) {
      const step = await inner.next();
      if (step.done) {
        result = step.value;
        break;
      }
      cb.onExtractionPartial?.(topic, slotsBefore, step.value);
    }
    if (!result) {
      throw new Error(
        "[convograph] extractor returned no final result — should be unreachable"
      );
    }
    return { _convograph_extractionResult: result };
  }

  async function commitSlots(state: typeof SubgraphState.State) {
    const topic = state._convograph_intentDecision!.topic;
    const result = state._convograph_extractionResult!;
    const slotsBefore = state._convograph_slotsBefore;

    let slotsAfter: SlotMap;
    if (result.abandon) {
      slotsAfter = {};
      await opts.drafts.abandon(state.threadId, topic);
    } else {
      slotsAfter = { ...slotsBefore, ...result.updated_slots };
      await opts.drafts.save(state.threadId, topic, slotsAfter);
    }

    cb.onExtractionFinal?.(topic, slotsBefore, slotsAfter, {
      reasoning: result.reasoning,
      ready_to_book: result.ready_to_book,
      abandon: result.abandon,
    });

    return { _convograph_slotsAfter: slotsAfter };
  }

  function decideAction(state: typeof SubgraphState.State) {
    const result = state._convograph_extractionResult!;
    const topic = state._convograph_intentDecision!.topic;
    const topicConfig = findTopic(opts.config, topic);
    const slotsAfter = state._convograph_slotsAfter;

    if (result.abandon) return "set_abandon_intent";
    if (
      result.ready_to_book &&
      topicConfig &&
      isDraftComplete(topicConfig, slotsAfter) &&
      opts.actions?.[topic]
    ) {
      return "execute_action";
    }
    if (topicConfig && isDraftComplete(topicConfig, slotsAfter)) {
      return "set_confirm_intent";
    }
    return "set_ask_slot_intent";
  }

  async function setAskSlotIntent(state: typeof SubgraphState.State) {
    const topic = state._convograph_intentDecision!.topic;
    const topicConfig = findTopic(opts.config, topic)!;
    const missing = firstMissingSlot(topicConfig, state._convograph_slotsAfter);
    const slotDef = topicConfig.slots.find((s) => s.name === missing);
    const intent: ReplyIntent = {
      kind: "ask_slot",
      slot: missing ?? "",
      slotDescription: slotDef?.description,
    };
    return { _convograph_replyIntent: intent };
  }

  async function setConfirmIntent(state: typeof SubgraphState.State) {
    const intent: ReplyIntent = {
      kind: "confirm",
      draft: state._convograph_slotsAfter,
    };
    return { _convograph_replyIntent: intent };
  }

  async function setAbandonIntent() {
    const intent: ReplyIntent = { kind: "abandon" };
    return { _convograph_replyIntent: intent };
  }

  async function executeAction(state: typeof SubgraphState.State) {
    const topic = state._convograph_intentDecision!.topic;
    const handler = opts.actions?.[topic];
    if (!handler) {
      throw new Error(
        `[convograph] executeAction reached but no action handler registered for topic "${topic}"`
      );
    }
    const result = await handler(state._convograph_slotsAfter, {
      threadId: state.threadId,
      userId: state.userId,
      topic,
    });
    cb.onActionResult?.(topic, result);
    return { _convograph_actionResult: result };
  }

  async function sealDraft(state: typeof SubgraphState.State) {
    const topic = state._convograph_intentDecision!.topic;
    await opts.drafts.seal(
      state.threadId,
      topic,
      state._convograph_slotsAfter,
      state._convograph_actionResult
    );
    const intent: ReplyIntent = {
      kind: "execute_success",
      draft: state._convograph_slotsAfter,
      result: state._convograph_actionResult,
    };
    return { _convograph_replyIntent: intent };
  }

  async function replyNode(state: typeof SubgraphState.State) {
    const topic = state._convograph_intentDecision!.topic;
    const topicConfig = findTopic(opts.config, topic)!;
    const intent = state._convograph_replyIntent!;
    const fullHistory: ChatTurn[] = [
      ...state._convograph_history,
      { role: "user" as const, content: state.userMessage },
    ];

    let reply = "";
    for await (const ev of streamReply({
      topic: topicConfig,
      history: fullHistory,
      draft: state._convograph_slotsAfter,
      intent,
      model: opts.model,
      jsonModeProvider: opts.jsonModeProvider,
      onUsage: (u) => cb.onUsage?.("reply", u),
    })) {
      if (ev.type === "reasoning_delta") cb.onReplyReasoningDelta?.(ev.delta);
      else {
        cb.onReplyTextDelta?.(ev.delta);
        reply += ev.delta;
      }
    }

    await historyAdapter.append(state.threadId, state.userMessage, reply);

    const decision = state._convograph_intentDecision!;
    const out: ConvographOutputState = {
      topic: decision.topic,
      confidence: decision.confidence,
      slots: state._convograph_slotsAfter,
      sealed: intent.kind === "execute_success",
      actionResult: state._convograph_actionResult,
      abandoned: intent.kind === "abandon",
    };
    return { agentReply: reply, convograph: out };
  }

  async function replyGeneric(state: typeof SubgraphState.State) {
    const fullHistory: ChatTurn[] = [
      ...state._convograph_history,
      { role: "user" as const, content: state.userMessage },
    ];
    const transcript = fullHistory
      .slice(-10)
      .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${m.content}`)
      .join("\n");

    const stream = streamText({
      model: opts.model,
      system:
        "You are a friendly assistant. Reply briefly (1-2 sentences) to the user's message. " +
        "Do not invent capabilities; if asked to do anything beyond chitchat, say what you can help with.",
      prompt: `Recent conversation:\n${transcript}\n`,
      temperature: 0.6,
    });

    let reply = "";
    for await (const delta of stream.textStream) {
      cb.onReplyTextDelta?.(delta);
      reply += delta;
    }
    const onUsage = cb.onUsage;
    if (onUsage) {
      try {
        const u = await stream.usage;
        onUsage("reply", {
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
          totalTokens: u.totalTokens ?? 0,
        });
      } catch {
        /* swallow — usage is best-effort */
      }
    }

    await historyAdapter.append(state.threadId, state.userMessage, reply);

    const decision = state._convograph_intentDecision;
    const out: ConvographOutputState = {
      topic: decision?.topic ?? SMALLTALK,
      confidence: decision?.confidence ?? 0,
      slots: {},
      sealed: false,
      abandoned: false,
    };
    return { agentReply: reply, convograph: out };
  }

  /* ── Graph ─────────────────────────────────────────────────────────── */

  const graph = new StateGraph(SubgraphState)
    .addNode("load_thread", loadThread)
    .addNode("classify_intent", classifyIntentNode)
    .addNode("sync_draft", syncDraft)
    .addNode("extract_slots", extractSlotsNode)
    .addNode("commit_slots", commitSlots)
    .addNode("set_ask_slot_intent", setAskSlotIntent)
    .addNode("set_confirm_intent", setConfirmIntent)
    .addNode("set_abandon_intent", setAbandonIntent)
    .addNode("execute_action", executeAction)
    .addNode("seal_draft", sealDraft)
    .addNode("reply", replyNode)
    .addNode("reply_generic", replyGeneric)
    .addEdge(START, "load_thread")
    .addEdge("load_thread", "classify_intent")
    .addConditionalEdges("classify_intent", routeAfterIntent, {
      sync_draft: "sync_draft",
      reply_generic: "reply_generic",
    })
    .addEdge("sync_draft", "extract_slots")
    .addEdge("extract_slots", "commit_slots")
    .addConditionalEdges("commit_slots", decideAction, {
      execute_action: "execute_action",
      set_ask_slot_intent: "set_ask_slot_intent",
      set_confirm_intent: "set_confirm_intent",
      set_abandon_intent: "set_abandon_intent",
    })
    .addEdge("execute_action", "seal_draft")
    .addEdge("seal_draft", "reply")
    .addEdge("set_ask_slot_intent", "reply")
    .addEdge("set_confirm_intent", "reply")
    .addEdge("set_abandon_intent", "reply")
    .addEdge("reply", END)
    .addEdge("reply_generic", END);

  return graph.compile();
}
