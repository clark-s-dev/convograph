# convograph

[![npm](https://img.shields.io/npm/v/convograph.svg)](https://www.npmjs.com/package/convograph)
[![Release](https://github.com/clark-s-dev/convograph/actions/workflows/release.yml/badge.svg)](https://github.com/clark-s-dev/convograph/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

A TypeScript framework for **slot-filling, topic-routing conversational agents**, designed to embed into existing LangGraph projects as a single subgraph node.

See [`SPEC.md`](./SPEC.md) for the design rationale.

---

## What it does

You write an `agent.yaml` describing your topics and slots. Convograph hands you back a compiled LangGraph subgraph that, on each user turn:

1. **Routes** the message into one of your topics (LLM-classified, YAML-driven).
2. **Extracts slots** for the active topic into a typed JSON shape (LLM, schema validated).
3. **Persists** the partial draft in your DB (you supply the adapter).
4. **Decides** whether to ask for the next slot, ask for confirmation, run the action, or acknowledge an abandon.
5. **Replies** in natural language with a streamed `{reasoning, reply}` JSON.

You keep ownership of: the LLM provider, the database, the action handlers, and the surrounding LangGraph topology. Convograph just wires them together.

---

## Install

```bash
npm install convograph
```

```ts
import { buildSubgraph, runTurnStream } from "convograph/graph";
import { parseConfig } from "convograph/config";
```

> Also mirrored on GitHub Packages as `@clark-s-dev/convograph` (same code, different registry — see [GitHub Packages docs](https://docs.github.com/packages) for auth setup if you prefer that source).

### Subpath exports

| Subpath | Use for |
|---|---|
| `convograph/graph` | `buildSubgraph`, `runTurnStream`, adapter types |
| `convograph/config` | `parseConfig`, `loadConfig`, slot/topic schema types |
| `convograph/router` | `streamClassifyIntent`, `RouterDecision` |
| `convograph/extractor` | `extractSlots`, `SlotMap`, `ExtractionResult` |
| `convograph/reply` | `streamReply`, `ReplyIntent` |
| `convograph/drafts` | `forThread<T>()` Postgres-backed slot store |
| `convograph/llm` | `streamStructured`, `createLlmClient` |
| `convograph/persistence` | low-level Postgres adapter + migrations |
| `convograph/codegen` | TS type generator from agent.yaml |
| `convograph/cli` | `runCli`, `runValidate`, `runMigrate`, `runCodegen` |

---

## Quick start (minimal)

### 1. Write `agent.yaml`

```yaml
name: my-support-bot
version: 1
instance_name: prod

database:
  url: ${DATABASE_URL}
  schema: convograph

llm:
  provider: openai-compatible
  model: meta/llama-3.3-70b-instruct
  base_url: https://integrate.api.nvidia.com/v1
  api_key: ${NVIDIA_API_KEY}
  temperature: 0.0

router:
  switch_confidence_threshold: 0.7

topics:
  - name: refund_request
    description: User wants a refund on a past order
    slots:
      - { name: order_id, type: string, required: true, description: "Order ID, format ABC-123" }
      - { name: reason,   type: string, required: true, description: "Why they want the refund" }

  - name: smalltalk
    description: Greetings, thanks, off-topic remarks
```

### 2. Build the subgraph

```ts
import { buildSubgraph } from "convograph/graph";
import { parseConfig } from "convograph/config";
import { readFileSync } from "node:fs";

const config = parseConfig(readFileSync("./agent.yaml", "utf8"));

const subgraph = buildSubgraph({
  config,
  model: myLanguageModel,             // any AI SDK LanguageModel instance
  jsonModeProvider: "nvidia",         // optional — sets response_format hint
  drafts: myDraftAdapter,             // see "Adapters" below
  history: myHistoryAdapter,          // optional
  actions: {
    refund_request: async (slots, { threadId, userId }) => {
      const result = await processRefund({
        orderId: slots.order_id as string,
        reason:  slots.reason as string,
      });
      return { ref: result.refundId, ...result };
    },
  },
  callbacks: {
    onRouterFinal: ({ topic, confidence }) => log.info({ topic, confidence }),
    onActionResult: (topic, result) => log.info("action ran", { topic, result }),
  },
});
```

### 3. Invoke per turn

```ts
const out = await subgraph.invoke({
  threadId: "<uuid>",
  userId: "user-42",
  userMessage: "I want a refund on order ABC-123, it arrived broken",
});

console.log(out.agentReply);
//   "Got it — what was the reason for the refund?"
console.log(out.convograph);
//   { topic: "refund_request", confidence: 0.95,
//     slots: { order_id: "ABC-123" },
//     sealed: false, abandoned: false }
```

---

## Embedding into an existing LangGraph

`buildSubgraph()` returns a standard `CompiledStateGraph`, so you wire it like any other node:

```ts
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { buildSubgraph } from "convograph/graph";

// Your host graph's state — only `threadId`, `userId`, `userMessage` need to
// match convograph's input contract; you can add anything else alongside.
const HostState = Annotation.Root({
  threadId:    Annotation<string>,
  userId:      Annotation<string>,
  userMessage: Annotation<string>,
  agentReply:  Annotation<string>({ reducer: (_p, n) => n, default: () => "" }),
  convograph:  Annotation<unknown>({ reducer: (_p, n) => n, default: () => ({}) }),
  // …whatever else your host needs
  ticketId:    Annotation<string | null>,
});

const convoNode = buildSubgraph({ config, model, drafts, history, actions });

const main = new StateGraph(HostState)
  .addNode("convo", convoNode)
  .addNode("escalate_to_human", escalateNode)
  .addEdge(START, "convo")
  .addConditionalEdges("convo", (s) => {
    // Inspect convograph's output and branch.
    const out = s.convograph as { sealed: boolean; abandoned: boolean };
    if (!out.sealed && !out.abandoned) return "convo"; // still slot-filling
    if (out.abandoned) return "escalate_to_human";
    return END;                                         // sealed → done
  })
  .addEdge("escalate_to_human", END);

const compiled = main.compile();
await compiled.invoke({ threadId, userId, userMessage });
```

The convograph subgraph is opaque to your host: its internal channels are namespaced `_convograph_*` so they cannot collide with yours, and its DB tables live in their own Postgres schema (`database.schema` in YAML).

---

## Streaming

For chat UIs that want token-by-token streaming and partial state updates, use `runTurnStream` instead of `subgraph.invoke`:

```ts
import { runTurnStream } from "convograph/graph";

for await (const ev of runTurnStream(
  { config, model, drafts, history, actions },
  { threadId, userId, userMessage }
)) {
  switch (ev.type) {
    case "router_partial":      uiUpdate.routerReasoning = ev.data.reasoning; break;
    case "router_final":        uiUpdate.topic           = ev.data.topic;     break;
    case "extraction_partial":  uiUpdate.draft           = ev.data.updated_slots; break;
    case "extraction_final":    uiUpdate.draft           = ev.slots_after;    break;
    case "reply_reasoning_delta": uiUpdate.thoughts     += ev.delta;          break;
    case "text_delta":          uiUpdate.reply          += ev.delta;          break;
    case "action_result":       uiUpdate.actionRef       = ev.result;         break;
    case "usage":               accumulateTokens(ev.usage);                   break;
    case "done":                finalizeOutput(ev.output);                    break;
    case "error":               throw ev.error;
  }
}
```

Every emitted event is fully typed via the `TurnEvent` discriminated union.

---

## Adapters

Convograph never touches your DB directly. You give it adapters; it calls them at the right moments.

### `DraftAdapter` (required)

```ts
interface DraftAdapter {
  load(threadId, topic):  Promise<SlotMap>;
  save(threadId, topic, slots): Promise<void>;
  seal(threadId, topic, finalSlots, actionResult): Promise<void>;
  abandon(threadId, topic): Promise<void>;
}
```

A Postgres-backed implementation is provided out of the box — see `lib/convograph/core/drafts/`. For tests, `lib/convograph/__tests__/helpers.ts` ships an in-memory `inMemoryDraftAdapter()` you can copy.

### `HistoryAdapter` (optional)

```ts
interface HistoryAdapter {
  load(threadId): Promise<{ role: "user" | "agent"; content: string }[]>;
  append(threadId, userMsg, agentReply): Promise<void>;
}
```

Defaults to no-op (every turn starts with empty history). Wire to your message store if you want the LLM to see prior turns.

### `actions` (per-topic, optional)

```ts
type ActionHandler = (
  slots: SlotMap,
  ctx: { threadId, userId, topic }
) => Promise<unknown>;
```

Topics without an action handler will route through the confirm/ask path but never execute. Topics like `smalltalk` don't need one.

---

## Testing your integration

You'll write small in-memory adapters and a scripted mock LLM. Reference implementations live in the [demo project's `lib/__tests__/helpers.ts`](https://github.com/clark-s-dev/convograph/blob/main/SPEC.md) — copy it as a starting point or adapt the shape:

```ts
// inMemoryDraftAdapter, scriptedModel, collect — see helpers.ts in the demo
import { scriptedModel, inMemoryDraftAdapter, collect } from "./test-helpers";

const drafts = inMemoryDraftAdapter();
const model = scriptedModel([
  // 1. Router LLM JSON
  `{"reasoning":"User wants a refund","topic":"refund_request","confidence":0.95}`,
  // 2. Extractor LLM JSON
  `{"reasoning":"Got order id","updated_slots":{"order_id":"ABC-123"},"ready_to_book":false,"abandon":false}`,
  // 3. Reply LLM JSON
  `{"reasoning":"Need reason","reply":"What's the reason for the refund?"}`,
]);

const events = await collect(
  runTurnStream(
    { config, model, drafts, actions: { refund_request: myAction } },
    { threadId: "test", userId: "u1", userMessage: "refund order ABC-123" }
  )
);

expect(drafts.store.active.get("test::refund_request")).toEqual({ order_id: "ABC-123" });
```

See `lib/convograph/__tests__/integration.test.ts` for fuller examples covering all reply branches.

Run all tests:

```bash
npm test
```

---

## CLI

```bash
npm run convograph -- validate    # validate agent.yaml against the schema
npx convograph migrate     # apply DB migrations
npx convograph codegen     # regenerate TS types from YAML
```

Or programmatic — see [`convograph/cli`](#subpath-exports).

---

## Module status

| # | Module | Status |
|---|---|---|
| 1 | YAML parser + schema + errors | ✅ |
| 2 | Postgres adapter + migrations | ✅ |
| 3 | Codegen (TS types from YAML) | ✅ |
| 4 | LLM wrapper + structured streaming helper | ✅ |
| 5 | Router + Extractor + Reply nodes | ✅ |
| 6 | RAG cascade | ⏸ deferred to v1 |
| 7 | `buildSubgraph()` + `runTurnStream()` | ✅ |
| 8 | CLI | ✅ |

---

## Layout

```
src/
├── core/
│   ├── config/        — YAML schema + parser + errors
│   ├── llm/           — streamStructured (partial-JSON + zod validation)
│   ├── router/        — streamClassifyIntent
│   ├── extractor/     — extractSlots (YAML-driven)
│   ├── reply/         — streamReply (intent-driven)
│   ├── drafts/        — drafts.forThread<T>() Postgres adapter
│   └── persistence/   — migrations runner + low-level adapter
├── graph/
│   ├── state.ts            — Annotation.Root + ConvographOutputState
│   ├── buildSubgraph.ts    — assembles the StateGraph
│   └── runTurnStream.ts    — async-generator wrapper for streaming
├── codegen/           — generates TS types from YAML
└── cli/               — validate / migrate / codegen
```

---

## Releases

This package uses [semantic-release](https://semantic-release.gitbook.io/). Pushes to `main` trigger a CI run that reads commit messages, bumps the version per [Conventional Commits](https://www.conventionalcommits.org/), and publishes to npm with a generated changelog. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

Apache 2.0.
