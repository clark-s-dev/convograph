/**
 * Bridge: convograph subgraph → async-generator of streaming TurnEvents.
 *
 * `buildSubgraph()` returns a `CompiledStateGraph` that exposes mid-node
 * progress only via the injected `SubgraphCallbacks`. The host app's chat
 * route, however, wants a `for await` stream of typed events so it can
 * forward each one as a UIMessage part.
 *
 * `runTurnStream()` glues the two together with an internal Promise-queue:
 *   • install callbacks that push `TurnEvent`s into the queue,
 *   • invoke the subgraph in the background,
 *   • yield events as they arrive,
 *   • close the queue once the invocation settles.
 *
 * Events are topic-agnostic (no flight/train specifics). The demo's
 * `lib/graph.ts` shim re-shapes these into its bespoke event shape if
 * needed; new hosts can consume them as-is.
 */

import {
  buildSubgraph,
  type BuildSubgraphOptions,
  type SubgraphCallbacks,
} from "./buildSubgraph";
import type { ConvographOutputState } from "./state";
import type { SlotMap } from "../core/extractor";
import type { UsageInfo } from "../core/llm";

/* ──────────────────────────────────────────────────────────────────────── */
/* TurnEvent — the public streaming wire format                              */
/* ──────────────────────────────────────────────────────────────────────── */

export type TurnEvent =
  | {
      type: "router_partial";
      data: { topic?: string; confidence?: number; reasoning?: string };
    }
  | {
      type: "router_final";
      data: { topic: string; confidence: number; reasoning: string };
    }
  | {
      type: "extraction_partial";
      topic: string;
      slots_before: SlotMap;
      data: {
        reasoning?: string;
        updated_slots?: SlotMap;
        ready_to_book?: boolean;
        abandon?: boolean;
      };
    }
  | {
      type: "extraction_final";
      topic: string;
      slots_before: SlotMap;
      slots_after: SlotMap;
      data: { reasoning: string; ready_to_book: boolean; abandon: boolean };
    }
  | { type: "reply_reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "action_result"; topic: string; result: unknown }
  | { type: "usage"; kind: "router" | "extractor" | "reply"; usage: UsageInfo }
  | { type: "done"; output: ConvographOutputState }
  | { type: "error"; error: Error };

export interface RunTurnStreamInput {
  threadId: string;
  userId: string;
  userMessage: string;
}

export type RunTurnStreamOptions = Omit<BuildSubgraphOptions, "callbacks"> & {
  /**
   * Optional extra callbacks that fire alongside the queue push. Useful
   * for side-channel logging without subscribing to the generator.
   */
  extraCallbacks?: SubgraphCallbacks;
};

/* ──────────────────────────────────────────────────────────────────────── */
/* Promise-queue: callback-driven source ⇒ async iterable                    */
/* ──────────────────────────────────────────────────────────────────────── */

class EventQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) resolver({ value, done: false });
    else this.queue.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length) {
      this.resolvers.shift()!({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.queue.length) {
      return Promise.resolve({ value: this.queue.shift()!, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((res) => this.resolvers.push(res));
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Public API                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

export async function* runTurnStream(
  opts: RunTurnStreamOptions,
  input: RunTurnStreamInput
): AsyncGenerator<TurnEvent, void, void> {
  const queue = new EventQueue<TurnEvent>();
  const extra = opts.extraCallbacks;

  const callbacks: SubgraphCallbacks = {
    onRouterPartial: (data) => {
      queue.push({ type: "router_partial", data });
      extra?.onRouterPartial?.(data);
    },
    onRouterFinal: (data) => {
      queue.push({ type: "router_final", data });
      extra?.onRouterFinal?.(data);
    },
    onExtractionPartial: (topic, slots_before, data) => {
      queue.push({ type: "extraction_partial", topic, slots_before, data });
      extra?.onExtractionPartial?.(topic, slots_before, data);
    },
    onExtractionFinal: (topic, slots_before, slots_after, data) => {
      queue.push({
        type: "extraction_final",
        topic,
        slots_before,
        slots_after,
        data,
      });
      extra?.onExtractionFinal?.(topic, slots_before, slots_after, data);
    },
    onReplyReasoningDelta: (delta) => {
      queue.push({ type: "reply_reasoning_delta", delta });
      extra?.onReplyReasoningDelta?.(delta);
    },
    onReplyTextDelta: (delta) => {
      queue.push({ type: "text_delta", delta });
      extra?.onReplyTextDelta?.(delta);
    },
    onActionResult: (topic, result) => {
      queue.push({ type: "action_result", topic, result });
      extra?.onActionResult?.(topic, result);
    },
    onUsage: (kind, usage) => {
      queue.push({ type: "usage", kind, usage });
      extra?.onUsage?.(kind, usage);
    },
  };

  const subgraph = buildSubgraph({ ...opts, callbacks });

  // Kick off the invocation in the background; close the queue once it settles.
  const invocation = (async () => {
    try {
      const out = await subgraph.invoke({
        threadId: input.threadId,
        userId: input.userId,
        userMessage: input.userMessage,
      });
      queue.push({ type: "done", output: out.convograph });
    } catch (err) {
      queue.push({
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      queue.close();
    }
  })();

  while (true) {
    const step = await queue.next();
    if (step.done) break;
    yield step.value;
  }

  // Surface any rejection that was swallowed by the invocation IIFE
  // (already converted to an "error" event but await the promise to
  // avoid an UnhandledRejection trace).
  await invocation;
}
