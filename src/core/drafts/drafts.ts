/**
 * Drafts utility API.
 *
 * Lets your hand-coded LangGraph agent code read/write per-thread/per-topic
 * slot state without touching the persistence layer directly. The slot
 * record lives in `convograph.drafts.slots` (JSONB). Slot types are
 * declared in agent.yaml and codegen produces the matching TypeScript
 * interfaces — pass that interface as the generic param T to get full
 * type safety.
 *
 *     import { drafts } from "@/lib/convograph";
 *     import type { FlightBookingSlots } from "@/lib/convograph/generated/types";
 *
 *     const flightDrafts = drafts.forThread<FlightBookingSlots>({
 *       pool, schema, threadId, topic: "flight_booking",
 *     });
 *     const current = await flightDrafts.current();        // Partial<FlightBookingSlots>
 *     await flightDrafts.upsert({ origin: "LAX" });
 *     await flightDrafts.complete({ ref: "BK-1234" });
 */

import type { Pool } from "pg";
import {
  PersistenceAdapter,
  type CompletedTaskRow,
} from "../persistence";

export interface ForThreadOptions {
  /** Postgres pool. Caller manages its lifecycle. */
  pool: Pool;
  /** Schema name (default: "convograph"). */
  schema?: string;
  /** Thread id (UUID expected). */
  threadId: string;
  /** Topic name as declared in agent.yaml. */
  topic: string;
}

export interface DraftHelpers<T extends object> {
  /** Current slot values, or {} if no active draft. */
  current(): Promise<Partial<T>>;

  /** True if there's an active (non-parked) draft for this (thread, topic). */
  exists(): Promise<boolean>;

  /**
   * Merge updates into the active draft, creating one if missing. Pass a
   * subset of slot fields — fields you don't include are left alone.
   */
  upsert(updates: Partial<T>): Promise<void>;

  /**
   * Replace the active draft's slots entirely (creating it if missing).
   * Use this when you've recomputed the full slot record and want to
   * blow away anything that's no longer present.
   */
  replace(slots: Partial<T>): Promise<void>;

  /**
   * Mark the draft complete. Atomically: snapshot the current slots into
   * convograph.completed_tasks, then delete the draft.
   * Throws if no active draft exists — call upsert() first.
   */
  complete(actionResult: object): Promise<{ completedTaskId: string }>;

  /**
   * Abandon the active draft (delete it, no completed_task row). Safe to
   * call when no draft exists — it's a no-op in that case.
   */
  abandon(reason?: string): Promise<void>;

  /**
   * Whether all listed required fields are populated in the current
   * slot record. Empty strings, null, and undefined are all treated as
   * "missing".
   */
  isComplete(requiredFields: (keyof T)[]): Promise<boolean>;

  /** Number of completed tasks for this (thread, topic). */
  completedCount(): Promise<number>;

  /** Most recent completed task for this (thread, topic), or null. */
  lastCompleted(): Promise<CompletedTaskRow | null>;
}

export function forThread<T extends object>(
  opts: ForThreadOptions
): DraftHelpers<T> {
  const adapter = new PersistenceAdapter(
    opts.pool,
    opts.schema ?? "convograph"
  );

  return {
    async current() {
      const draft = await adapter.getActiveDraft(opts.threadId, opts.topic);
      return (draft?.slots ?? {}) as Partial<T>;
    },

    async exists() {
      const draft = await adapter.getActiveDraft(opts.threadId, opts.topic);
      return draft !== null;
    },

    async upsert(updates) {
      let draft = await adapter.getActiveDraft(opts.threadId, opts.topic);
      if (!draft) {
        draft = await adapter.upsertDraft(
          opts.threadId,
          opts.topic,
          updates as Record<string, unknown>
        );
      }
      const merged = {
        ...draft.slots,
        ...(updates as Record<string, unknown>),
      };
      await adapter.updateDraftSlots(draft.id, merged);
    },

    async replace(slots) {
      let draft = await adapter.getActiveDraft(opts.threadId, opts.topic);
      if (!draft) {
        draft = await adapter.upsertDraft(
          opts.threadId,
          opts.topic,
          slots as Record<string, unknown>
        );
      }
      await adapter.updateDraftSlots(
        draft.id,
        slots as Record<string, unknown>
      );
    },

    async complete(actionResult) {
      const draft = await adapter.getActiveDraft(opts.threadId, opts.topic);
      if (!draft) {
        throw new Error(
          `[convograph drafts] complete() called for thread=${opts.threadId} topic=${opts.topic} but no active draft exists. ` +
            `Call upsert() first to create one.`
        );
      }
      const result = await adapter.completeDraft(
        draft.id,
        actionResult as Record<string, unknown>
      );
      return { completedTaskId: result.id };
    },

    async abandon(reason) {
      const draft = await adapter.getActiveDraft(opts.threadId, opts.topic);
      if (draft) await adapter.abandonDraft(draft.id, reason);
    },

    async isComplete(requiredFields) {
      const slots = await this.current();
      return requiredFields.every((f) => {
        const v = slots[f];
        return v !== undefined && v !== null && v !== "";
      });
    },

    async completedCount() {
      const tasks = await adapter.queryCompletedTasks({
        threadId: opts.threadId,
        topic: opts.topic,
        limit: 1000,
      });
      return tasks.length;
    },

    async lastCompleted() {
      const tasks = await adapter.queryCompletedTasks({
        threadId: opts.threadId,
        topic: opts.topic,
        limit: 1,
      });
      return tasks[0] ?? null;
    },
  };
}
