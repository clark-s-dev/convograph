/**
 * High-level CRUD wrapper over the convograph schema.
 *
 * Every other module in convograph uses this — never raw SQL elsewhere.
 * Schema name is configurable; queries are parameterised.
 *
 * Methods are organized by entity:
 *   threads      — getOrCreateThread, updateThreadPointers
 *   messages     — appendMessage
 *   drafts       — getActiveDraft, upsertDraft, updateDraftSlots,
 *                  appendMessageToDraftBucket, abandonDraft
 *   completed    — completeDraft, queryCompletedTasks
 */

import type { Pool } from "pg";
import type {
  CompletedTaskRow,
  DraftRow,
  MessageRow,
  ThreadRow,
} from "./types";

/** Sanity-check a schema identifier; pg interpolates it directly into SQL. */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(
      `Invalid schema name ${JSON.stringify(name)}: must match [A-Za-z_][A-Za-z0-9_]*`
    );
  }
  return `"${name}"`;
}

export class PersistenceAdapter {
  readonly schema: string;
  /** Quoted, ready-to-interpolate schema identifier. */
  private readonly _q: string;

  constructor(
    private readonly pool: Pool,
    schema: string = "convograph"
  ) {
    this.schema = schema;
    this._q = quoteIdent(schema);
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /* Threads                                                              */
  /* ─────────────────────────────────────────────────────────────────── */

  /**
   * Find an existing thread by id, or create a new one for this user.
   * The threadId is supplied by the caller (so client-side UUIDs work).
   */
  async getOrCreateThread(
    threadId: string,
    externalUserId: string,
    externalOrgId?: string | null
  ): Promise<ThreadRow> {
    const existing = await this.pool.query<ThreadRow>(
      `SELECT * FROM ${this._q}.threads WHERE id = $1`,
      [threadId]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return existing.rows[0];
    }

    const inserted = await this.pool.query<ThreadRow>(
      `INSERT INTO ${this._q}.threads (id, external_user_id, external_org_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET last_active_at = NOW()
       RETURNING *`,
      [threadId, externalUserId, externalOrgId ?? null]
    );
    return inserted.rows[0];
  }

  /** Update the topic / instance pointers and last_active_at. */
  async updateThreadPointers(
    threadId: string,
    currentTopic: string | null,
    currentInstanceId: string | null
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this._q}.threads
       SET current_topic = $2,
           current_instance_id = $3,
           last_active_at = NOW()
       WHERE id = $1`,
      [threadId, currentTopic, currentInstanceId]
    );
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /* Messages                                                             */
  /* ─────────────────────────────────────────────────────────────────── */

  async appendMessage(
    threadId: string,
    role: "user" | "agent" | "system",
    content: unknown,
    parentUuid?: string | null
  ): Promise<MessageRow> {
    const res = await this.pool.query<MessageRow>(
      `INSERT INTO ${this._q}.messages (thread_id, role, content, parent_uuid)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [threadId, role, JSON.stringify(content), parentUuid ?? null]
    );
    return res.rows[0];
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /* Drafts                                                               */
  /* ─────────────────────────────────────────────────────────────────── */

  /**
   * Get the active (non-parked) draft for (thread, topic), or null.
   * The DB enforces at most one active draft per (thread, topic) via a
   * partial unique index.
   */
  async getActiveDraft(
    threadId: string,
    topic: string
  ): Promise<DraftRow | null> {
    const res = await this.pool.query<DraftRow>(
      `SELECT * FROM ${this._q}.drafts
       WHERE thread_id = $1 AND topic = $2 AND is_parked = FALSE`,
      [threadId, topic]
    );
    return res.rows[0] ?? null;
  }

  /**
   * Insert an active draft, or return the existing active one for this
   * (thread, topic) if one already exists.
   */
  async upsertDraft(
    threadId: string,
    topic: string,
    initialSlots: Record<string, unknown> = {}
  ): Promise<DraftRow> {
    const existing = await this.getActiveDraft(threadId, topic);
    if (existing) return existing;

    const res = await this.pool.query<DraftRow>(
      `INSERT INTO ${this._q}.drafts (thread_id, topic, slots)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [threadId, topic, JSON.stringify(initialSlots)]
    );
    return res.rows[0];
  }

  async updateDraftSlots(
    draftId: string,
    slots: Record<string, unknown>
  ): Promise<DraftRow> {
    const res = await this.pool.query<DraftRow>(
      `UPDATE ${this._q}.drafts
       SET slots = $2::jsonb,
           last_touched_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [draftId, JSON.stringify(slots)]
    );
    if (res.rowCount === 0) {
      throw new Error(`updateDraftSlots: draft ${draftId} not found`);
    }
    return res.rows[0];
  }

  /** Append a message id to the draft's msg_bucket array. */
  async appendMessageToDraftBucket(
    draftId: string,
    messageId: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${this._q}.drafts
       SET msg_bucket = msg_bucket || to_jsonb($2::text),
           last_touched_at = NOW()
       WHERE id = $1`,
      [draftId, messageId]
    );
  }

  /**
   * Mark a draft as abandoned. v0 implementation: just deletes the row
   * (no audit event). Future: emit an event to a separate `abandon_log`
   * table. The `reason` arg is accepted for API stability.
   */
  async abandonDraft(draftId: string, _reason?: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this._q}.drafts WHERE id = $1`,
      [draftId]
    );
  }

  /* ─────────────────────────────────────────────────────────────────── */
  /* Completed tasks                                                      */
  /* ─────────────────────────────────────────────────────────────────── */

  /**
   * Atomically: insert into completed_tasks + delete the draft.
   * Returns the new completed_task row.
   */
  async completeDraft(
    draftId: string,
    actionResult: Record<string, unknown>
  ): Promise<CompletedTaskRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Lock + read the draft
      const draftRes = await client.query<DraftRow>(
        `SELECT * FROM ${this._q}.drafts WHERE id = $1 FOR UPDATE`,
        [draftId]
      );
      if (draftRes.rowCount === 0) {
        throw new Error(`completeDraft: draft ${draftId} not found`);
      }
      const draft = draftRes.rows[0];

      // Insert completed_task with the slot snapshot
      const completedRes = await client.query<CompletedTaskRow>(
        `INSERT INTO ${this._q}.completed_tasks
           (thread_id, topic, slots_snapshot, action_result)
         VALUES ($1, $2, $3::jsonb, $4::jsonb)
         RETURNING *`,
        [
          draft.thread_id,
          draft.topic,
          JSON.stringify(draft.slots),
          JSON.stringify(actionResult),
        ]
      );

      // Delete the draft
      await client.query(`DELETE FROM ${this._q}.drafts WHERE id = $1`, [
        draftId,
      ]);

      await client.query("COMMIT");
      return completedRes.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async queryCompletedTasks(opts: {
    threadId?: string;
    topic?: string;
    limit?: number;
  } = {}): Promise<CompletedTaskRow[]> {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (opts.threadId) {
      params.push(opts.threadId);
      wheres.push(`thread_id = $${params.length}`);
    }
    if (opts.topic) {
      params.push(opts.topic);
      wheres.push(`topic = $${params.length}`);
    }
    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    params.push(limit);
    const limitClause = `LIMIT $${params.length}`;

    const res = await this.pool.query<CompletedTaskRow>(
      `SELECT * FROM ${this._q}.completed_tasks
       ${whereClause}
       ORDER BY completed_at DESC
       ${limitClause}`,
      params
    );
    return res.rows;
  }
}
