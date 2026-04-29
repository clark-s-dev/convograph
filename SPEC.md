# convograph — Specification

> **Status:** v0 in progress. Built in-tree inside `demo-chat-agent` until v0 is done, then extracted to its own repo.

> **Audience:** anyone implementing or reviewing convograph itself.

> **North star:** [`acme-support-bot`](https://github.com/clark-s-dev/acme-support-bot) — a fictional consumer project with full integration spec. Anything in this doc must let acme-support-bot's setup work.

---

## 1. What is convograph?

A TypeScript framework for **slot-filling, topic-routing conversational agents** that embed cleanly into existing **LangGraph** projects.

The user writes:
- A `agent.yaml` declaring topics, slot schemas, prompts, actions
- A handful of action handlers (TypeScript functions for side effects)
- A few hook handlers (optional — for permission checks, audit logs, etc.)

The framework provides:
- A complete LangGraph subgraph implementing the topic-router + per-topic slot extraction + reply generation + action execution loop
- Auto-generated DB schema (drafts, completed_tasks, messages, threads) under an isolated `convograph` Postgres schema
- Auto-generated TypeScript types from the YAML
- A streaming UI message protocol (built on AI SDK's `createUIMessageStream`) with custom data parts for router decisions, slot extractions, and bookings
- A CLI (`convograph init / migrate / codegen / validate / dev`)
- Optional RAG-augmented intent classification (k-NN on cached cases + LLM fallback)

## 2. Three integration modes (v0 supports A only)

**Mode A — Subgraph embedding (v0 target).**
Convograph exposes `buildSubgraph(opts)` returning a standard LangGraph `CompiledStateGraph`. Host project's main graph adds it as a single node. External dependencies (DB, checkpointer, LLM client) are injected.

**Mode B — Library (utilities only).**
Host imports `convograph.utils.*` (classifyIntent, upsertDraft, extractSlots, completeDraft) and writes its own graph topology. Useful when host has complex non-conversational nodes.

**Mode C — Standalone server.**
Convograph runs its own Express/HTTP server and the host just hits the `/api/chat` endpoint. Simplest for greenfield projects.

v0 implements Mode A. The same internal modules support all three modes — mode A is just the most opinionated wrapper. Modes B and C are deferred.

## 3. v0 scope

**In scope:**
- YAML config schema + parser + validation
- Postgres schema + migrations (drafts, completed_tasks, messages, threads, user_preferences)
- TypeScript codegen from YAML
- LLM wrapper (NVIDIA NIM via OpenAI-compatible adapter; pluggable later)
- Tagger node (intent classification)
- Extractor node (per-topic slot extraction with streaming partial JSON)
- Reply node (structured `{reasoning, reply}` JSON, both streamed)
- Action execution
- `buildSubgraph()` API with injectable deps
- CLI: `validate / migrate / codegen / dev`
- Working acme-support-bot-style demo (refund + subscription topics) as integration test

**Out of scope for v0:**
- Multi-LLM provider switching at runtime
- RAG cascade (basic LLM fallback, no k-NN)
- Hooks (permission checks, audit logs)
- User preferences extraction
- External vector DB
- Streaming UI in CLI dev mode
- Modes B and C

## 4. YAML config schema

The full reference. v0 implements all sections marked **REQUIRED** and at least the minimum viable subset of optional ones.

### 4.1 Top-level

```yaml
name: my-bot                    # REQUIRED
version: 1                      # REQUIRED. Used for migration tracking.
instance_name: my_bot           # Optional. Used as table prefix; default = name with hyphens replaced.

database:                       # REQUIRED for v0
  url: ${DATABASE_URL}
  schema: convograph            # Default 'convograph'

llm:                            # REQUIRED
  provider: nvidia              # 'nvidia' | 'openai-compatible' | (extensible later)
  model: meta/llama-3.3-70b-instruct
  api_key: ${NVIDIA_API_KEY}
  temperature: 0.1              # Default 0.1
  max_output_tokens: 1024       # Default 1024

router:                         # Optional but recommended
  prompt: |                     # Custom system prompt. Sane default if absent.
    You are an intent router for ...
  switch_confidence_threshold: 0.7  # Below this → ask user to clarify

topics: [...]                   # REQUIRED. At least 1 topic.

policies:                       # Optional
  on_new_instance_with_open_draft: confirm  # 'confirm' | 'abandon' | 'park'. Default 'confirm'.
  carry_slots_across_instances: false       # Default false (slots reset per task instance)
  slot_confidence_threshold: 0.7            # Below this → don't commit slot
  draft_ttl_days: 14                        # Auto-abandon idle drafts after N days
```

### 4.2 Topic

```yaml
- name: refund                  # REQUIRED. Used as topic id.
  description: "Customer requesting a refund"   # REQUIRED. Shown to router LLM.

  slots:                        # REQUIRED. At least 1 slot.
    - name: order_id            # REQUIRED.
      type: string              # REQUIRED. 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'time' | 'datetime' | 'enum' | 'email' | 'phone' | 'url'
      required: true            # Default false
      description: "Order ID like ORD-123456"   # Surfaced to extractor LLM.
      default: 1                # Optional default value
      min: 1                    # For numeric/integer
      max: 9                    # For numeric/integer
      values: [a, b, c]         # REQUIRED if type=enum
      max_length: 500           # For string
      from_preference: cabin_class  # Pull default from user_preferences (deferred to v1)
      validate:                 # Optional declarative validators (deferred to v1)
        - rule: "regex:^ORD-[0-9]{6}$"
          message: "Order ID must look like ORD-123456"

  completion:                   # Optional, defaults to "all required slots filled + user confirms"
    required_slots: [order_id, reason, refund_amount]
    requires_user_confirm: true   # Default true
    requires_human_approval_when: # Deferred to v1
      - "refund_amount > 500"

  action:                       # REQUIRED
    handler: ./handlers/refund.ts   # Path to TypeScript file exporting `complete`
    idempotency_key_from: [order_id]
    timeout_ms: 30000             # Default 30s

  prompts:                      # Optional. Templates with {slot} interpolation.
    ask_slot:                   # Per-slot questions
      order_id: "What's the order ID?"
    confirm: "Refund ${refund_amount} for {order_id}. Proceed?"
    success: "Done. Ref: {action_result.refund_ref}"
```

### 4.3 Hooks (deferred to v1)

```yaml
hooks:
  beforeAction: ./hooks/permissionCheck.ts
  afterAction: ./hooks/auditLog.ts
  onAbandon: ./hooks/auditLog.ts
  onError: ./hooks/errorReport.ts
```

### 4.4 RAG (deferred to v1)

```yaml
router:
  rag:
    enabled: true
    cases_dir: ./cases
    top_k: 5
    similarity_threshold: 0.85
    margin_threshold: 0.05
    majority_threshold: 0.8
```

## 5. Public API

### 5.1 `buildSubgraph(opts)` — primary entry point

```typescript
import { buildSubgraph } from "convograph";

const subgraph = await buildSubgraph({
  yamlPath: "./agent.yaml",         // REQUIRED
  db: existingPgPool,                // Optional. If absent, convograph creates its own from config.
  checkpointer: mainCheckpointer,    // Optional. If absent, convograph creates a MemorySaver.
  llmClient: existingClient,         // Optional. If absent, created from llm config.
  hooks: { ... },                    // Optional runtime hooks (deferred to v1)
  logger: console,                   // Optional. Default: console.
});

// Use as a standard LangGraph node:
mainGraph.addNode("chat", subgraph);
```

Returns `CompiledStateGraph<InputState, OutputState>` matching LangGraph TS conventions.

### 5.2 Input/Output state contract

**Input state** (the host graph must provide these channels):
- `threadId: string` — conversation id
- `userId: string` — user id (free-form, opaque)
- `userMessage: string` — the latest user utterance

**Output state** (convograph populates these):
- `agentReply: string` — final user-facing message
- `convograph: ConvographOutputState` — namespaced details (active topic, completed task id, metrics, etc.)

### 5.3 `convograph.utils.*` (Mode B utility surface, partial in v0)

```typescript
convograph.utils.classifyIntent(history, query, config)
convograph.utils.extractSlots(topic, history, currentDraft, config)
convograph.utils.upsertDraft(threadId, topic, db)
convograph.utils.completeDraft(draftId, actionResult, db)
convograph.utils.abandonDraft(draftId, db)
convograph.utils.queryCompletedTasks(userId, topic?, limit?, db)
```

These are the building blocks the subgraph composes; exporting them lets Mode B users build their own graph.

## 6. Internal architecture

### 6.1 Graph topology (fixed in v0)

```
START
  │
  ▼
load_thread ──────► (loads thread from DB; creates if missing)
  │
  ▼
classify_intent ──► (Tagger: streaming JSON {reasoning, topic, confidence})
  │
  ▼
route_decision ───► branches by topic
  │
  ├── "smalltalk" ─────────────► reply_generic ──► END
  │
  └── "<task topic>" ──► sync_draft ──► (creates/loads/resets draft)
                              │
                              ▼
                        scope_message ──► (appends user message to draft's bucket)
                              │
                              ▼
                        extract_slots ──► (streaming JSON {reasoning, updated_slots, ready_to_book, abandon})
                              │
                              ▼
                        commit_slots ───► (writes to DB)
                              │
                              ▼
                        decide_response ► branches by state
                              │
                              ├── "ask_slot" ──► reply_ask ──► END
                              ├── "confirm" ───► reply_confirm ──► END
                              ├── "execute" ───► execute_action ──► seal_draft ──► reply_success ──► END
                              └── "abandon" ───► reply_abandon ──► END
```

### 6.2 State channels (subgraph internal)

Namespaced with `_convograph_` prefix to avoid collisions with the host graph:

- `_convograph_intentDecision` — Tagger's structured output
- `_convograph_activeDraft` — current draft row
- `_convograph_extractionResult` — Extractor's structured output
- `_convograph_replyIntent` — what to convey (ask_slot / confirm / execute / abandon)

These are private; host graph never sees them.

### 6.3 Persistence adapter

Wraps the LangGraph state's per-turn changes and translates them to DB writes. Single class; injected into nodes.

```typescript
class PersistenceAdapter {
  upsertDraft(threadId, topic, slotsBefore): Draft
  updateDraftSlots(draftId, slots): void
  appendMessageToBucket(draftId, message): void
  completeDraft(draftId, actionResult): CompletedTask
  abandonDraft(draftId, reason): void
  loadThread(threadId): ThreadState
  saveThread(thread): void
}
```

### 6.4 LLM call sites

Three structured LLM calls per turn (all streaming JSON):
1. **Router** — `{reasoning, topic, confidence}`
2. **Extractor** — `{reasoning, updated_slots, ready_to_book, abandon}` (only on task topics)
3. **Reply** — `{reasoning, reply}` (always; smalltalk path uses canned text)

Each lives in `core/tagger/`, `core/extractor/`, `core/reply/`. They share a `streamStructuredJson(model, system, prompt, schema)` helper that does partial-JSON parsing.

## 7. DB schema

All tables live in the `convograph` Postgres schema (or whatever the YAML config specifies). The host project's tables are never touched.

```sql
CREATE TABLE convograph.threads (
  id            UUID PRIMARY KEY,
  external_user_id TEXT NOT NULL,
  current_topic TEXT,
  current_instance_id UUID,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE convograph.messages (
  id            UUID PRIMARY KEY,
  thread_id     UUID NOT NULL REFERENCES convograph.threads(id),
  role          TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  content       JSONB NOT NULL,
  parent_uuid   UUID REFERENCES convograph.messages(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE convograph.drafts (
  id            UUID PRIMARY KEY,
  thread_id     UUID NOT NULL REFERENCES convograph.threads(id),
  topic         TEXT NOT NULL,
  slots         JSONB NOT NULL DEFAULT '{}',
  msg_bucket    JSONB NOT NULL DEFAULT '[]',  -- array of message ids
  is_parked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_touched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (thread_id, topic) WHERE NOT is_parked
);

CREATE TABLE convograph.completed_tasks (
  id            UUID PRIMARY KEY,
  thread_id     UUID NOT NULL REFERENCES convograph.threads(id),
  topic         TEXT NOT NULL,
  slots_snapshot JSONB NOT NULL,
  action_result JSONB NOT NULL,
  parent_instance_id UUID REFERENCES convograph.completed_tasks(id),
  completed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE convograph.user_preferences (
  external_user_id TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (external_user_id, key)
);
```

The `UNIQUE (thread_id, topic) WHERE NOT is_parked` constraint enforces "max one active draft per (thread, topic)" — the core invariant of the architecture.

## 8. Codegen

`convograph codegen` reads `agent.yaml` and writes to `<configurable>/generated/`:

- **`types.ts`** — TS interfaces for each topic's slots (e.g. `RefundSlots`), action result types, hook context types
- **`schemas.ts`** — Zod schemas (runtime equivalents of types.ts)
- **`handlers.d.ts`** — typed function signatures for each topic's action handler

Generated files are gitignored in dev (regen on every build) but written into CI artifacts for production.

## 9. CLI

```bash
convograph validate <yaml>      # Lint YAML, check handler files exist
convograph migrate              # Apply DB migrations (idempotent)
convograph codegen              # Regenerate types from YAML
convograph dev                  # Dev server (Mode C, optional in v0)
```

## 10. Phased v0 implementation roadmap

| Module | Scope | Lands at |
|---|---|---|
| 1 | YAML parser + Zod schema + structured errors | `core/config/` |
| 2 | DB layer + migrations + persistence adapter | `core/persistence/` |
| 3 | Codegen | `codegen/` |
| 4 | LLM wrapper + structured streaming helper | `core/llm/` |
| 5 | Tagger / Extractor / Reply nodes | `core/tagger/`, `core/extractor/`, `core/reply/` |
| 6 | RAG cascade (deferred — empty stub in v0) | `core/tagger/rag.ts` |
| 7 | `buildSubgraph()` glue + nodes/ + state channels | `graph/` |
| 8 | CLI + scripts | `cli/` |

After Module 7, the `demo-chat-agent` runs entirely on convograph by replacing `lib/graph.ts` with a thin wrapper. After Module 8, the developer experience is polished and we extract to a separate repo.

## 11. Migration of demo-chat-agent (running in parallel)

After each module lands, the corresponding piece of demo code is replaced:

| After module | Demo migration |
|---|---|
| 1 | `agent.yaml` is added at root and parsed at startup. No runtime change. |
| 2 | Demo's in-memory `Map` is augmented with shadow writes to DB. Both run side by side. |
| 3 | Demo agents start importing types from `lib/convograph/generated/`. |
| 4 | Demo's `lib/llm.ts` is moved into `lib/convograph/core/llm/`. Demo agents re-import from there. |
| 5 | Demo's `lib/agents/router.ts`, `flight.ts`, `train.ts` are replaced one by one with convograph's generic nodes parameterized by YAML. |
| 6 | (No demo change — RAG is deferred.) |
| 7 | Demo's `lib/graph.ts` becomes a thin call to `buildSubgraph(yamlPath)`. |
| 8 | Demo runs `npx convograph migrate / codegen / validate` as npm scripts. |

## 12. Design properties to preserve

These are non-negotiable for v0:

- **Subgraph mode A**: convograph integrates as a single LangGraph node, not a whole framework.
- **Schema isolation**: convograph's tables live in their own Postgres schema; host's tables untouched.
- **State channel namespacing**: convograph internal channels are private to the subgraph.
- **Streaming everything**: Tagger / Extractor / Reply all stream their structured outputs as partial JSON.
- **Task-instance isolation**: same topic, two consecutive tasks → second draft starts empty (no slot inheritance from the sealed prior).
- **Single-source-of-truth slots**: slots live on the draft row. Nowhere else holds a redundant copy.

## 13. Open design questions

These are deferred decisions, not blockers for v0:

- **Slot reset policy default**: sticky vs reset on returning to a topic. Currently default = reset (no carry-over).
- **Multi-LLM provider switching**: deferred to v1; v0 supports one provider per project (NVIDIA via openai-compatible).
- **RAG cascade case format**: JSONL with `{context, label, reasoning}` planned but not implemented in v0.
- **Tool-calling vs structured output for slot extraction**: v0 uses structured output. Tool-calling deferred.
- **Hooks**: surface defined but not implemented in v0.
- **Vector DB**: not in v0; if RAG is added in v1, start with an in-memory hnswlib-node index.

## 14. Out-of-scope (won't ever do)

- Custom graph topologies beyond the fixed one in §6.1
- Subagents / multi-agent within a single topic
- Voice/audio modalities
- Multi-tenant data isolation beyond the schema-level (host's responsibility)
- Hot reload of `agent.yaml`

## 15. Testing strategy

- **Unit tests** in each module (Vitest)
- **Integration test**: spin up Postgres, build a subgraph from a fixture YAML, run a sequence of `(threadId, message)` turns through it, assert state transitions
- **End-to-end**: the `demo-chat-agent` itself serves as the e2e test once Module 7 lands

## 16. License

Apache 2.0.
