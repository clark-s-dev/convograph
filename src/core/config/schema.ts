/**
 * Zod schemas for the convograph agent.yaml configuration.
 *
 * Mirrors the spec in lib/convograph/SPEC.md §4. Most fields are optional
 * with sensible defaults so a minimal viable config is short.
 *
 * Fields marked "deferred to v1" are accepted in the schema (so users can
 * write them now without errors) but ignored by v0 runtime code.
 */

import { z } from "zod";

/* ──────────────────────────────────────────────────────────────────────── */
/* Slot definition                                                           */
/* ──────────────────────────────────────────────────────────────────────── */

const slotTypeSchema = z.enum([
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "time",
  "datetime",
  "enum",
  "email",
  "phone",
  "url",
]);

export const validateRuleSchema = z.object({
  rule: z.string(),
  message: z.string().optional(),
});

export const slotSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9_]*$/,
        "Slot name must be snake_case starting with a lowercase letter."
      ),
    type: slotTypeSchema,
    required: z.boolean().default(false),
    description: z.string().optional(),
    default: z
      .union([z.string(), z.number(), z.boolean()])
      .optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    values: z.array(z.string()).optional(), // required when type === 'enum'
    max_length: z.number().int().positive().optional(),
    from_preference: z.string().optional(), // deferred to v1
    validate: z.array(validateRuleSchema).optional(), // deferred to v1
  })
  .refine(
    (s) => s.type !== "enum" || (s.values && s.values.length > 0),
    {
      message: "Enum slots must declare a non-empty `values` array.",
      path: ["values"],
    }
  );

export type Slot = z.infer<typeof slotSchema>;

/* ──────────────────────────────────────────────────────────────────────── */
/* Topic                                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

export const completionSchema = z
  .object({
    required_slots: z.array(z.string()).optional(),
    requires_user_confirm: z.boolean().default(true),
    requires_human_approval_when: z.array(z.string()).optional(), // deferred to v1
  })
  .default({ requires_user_confirm: true });

export const actionSchema = z.object({
  handler: z.string().min(1).describe("Path to TypeScript file exporting `complete`."),
  idempotency_key_from: z.array(z.string()).optional(),
  timeout_ms: z.number().int().positive().default(30_000),
});

export const promptsSchema = z
  .object({
    ask_slot: z.record(z.string(), z.string()).optional(), // slot_name → question
    confirm: z.string().optional(),
    success: z.string().optional(),
    pending_approval: z.string().optional(),
  })
  .optional();

export const topicSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9_]*$/,
        "Topic name must be snake_case starting with a lowercase letter."
      ),
    description: z.string().min(1, "Topic description is required (shown to the router LLM)."),
    /**
     * Slot schemas for this topic. Empty array allowed — useful for
     * topics like "smalltalk" that have no extractable structure.
     */
    slots: z.array(slotSchema).default([]),
    /**
     * Optional. Convograph itself does not consume `completion` in v0
     * (Mode B / utility surface design); your hand-coded agent code
     * decides when a task is complete. Schema is here for forward-compat.
     */
    completion: completionSchema.optional(),
    /**
     * Optional. Convograph does not load handlers in v0 — your hand-coded
     * agent code calls its own action functions. Kept in the schema so
     * users can declare intent if they want (e.g. for documentation).
     */
    action: actionSchema.optional(),
    /** Optional prompt templates. Convograph does not consume these in v0. */
    prompts: promptsSchema,
  })
  .refine(
    (t) => {
      // Slot names within a topic must be unique
      const names = t.slots.map((s) => s.name);
      return new Set(names).size === names.length;
    },
    { message: "Slot names within a topic must be unique.", path: ["slots"] }
  )
  .refine(
    (t) => {
      // required_slots, if specified, must reference real slot names
      const declared = new Set(t.slots.map((s) => s.name));
      const required = t.completion?.required_slots ?? [];
      return required.every((s) => declared.has(s));
    },
    {
      message:
        "completion.required_slots references slot names that aren't defined on this topic.",
      path: ["completion", "required_slots"],
    }
  );

export type Topic = z.infer<typeof topicSchema>;

/* ──────────────────────────────────────────────────────────────────────── */
/* Top-level config                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

export const databaseSchema = z.object({
  url: z.string().min(1),
  schema: z.string().default("convograph"),
  table_prefix: z.string().optional(),
  migrations_dir: z.string().optional(),
});

export const llmSchema = z.object({
  provider: z.enum(["nvidia", "openai-compatible"]).default("nvidia"),
  model: z.string().min(1),
  base_url: z.string().url().optional(),
  embedding_model: z.string().optional(),
  api_key: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.1),
  max_output_tokens: z.number().int().positive().default(1024),
});

export const ragSchema = z
  .object({
    enabled: z.boolean().default(false),
    cases_dir: z.string().optional(),
    top_k: z.number().int().positive().default(5),
    similarity_threshold: z.number().min(0).max(1).default(0.85),
    margin_threshold: z.number().min(0).max(1).default(0.05),
    majority_threshold: z.number().min(0).max(1).default(0.8),
    inject_cases_as_few_shot: z.boolean().default(true),
  })
  .optional();

export const routerSchema = z
  .object({
    prompt: z.string().optional(),
    switch_confidence_threshold: z.number().min(0).max(1).default(0.7),
    rag: ragSchema,
  })
  .default({ switch_confidence_threshold: 0.7 });

export const policiesSchema = z
  .object({
    on_new_instance_with_open_draft: z
      .enum(["confirm", "abandon", "park"])
      .default("confirm"),
    carry_slots_across_instances: z.boolean().default(false),
    slot_confidence_threshold: z.number().min(0).max(1).default(0.7),
    draft_ttl_days: z.number().int().positive().default(14),
  })
  .default({
    on_new_instance_with_open_draft: "confirm",
    carry_slots_across_instances: false,
    slot_confidence_threshold: 0.7,
    draft_ttl_days: 14,
  });

export const hooksSchema = z
  .object({
    beforeAction: z.string().optional(),
    afterAction: z.string().optional(),
    onAbandon: z.string().optional(),
    onError: z.string().optional(),
  })
  .optional();

export const memorySchema = z
  .object({
    enabled: z.boolean().default(false),
    preferences_extracted: z.boolean().default(false),
    preferences_topics: z.record(z.string(), z.array(z.string())).optional(),
  })
  .optional();

export const observabilitySchema = z
  .object({
    emit_events: z.boolean().default(true),
    metrics: z
      .object({
        enabled: z.boolean().default(false),
        namespace: z.string().optional(),
      })
      .optional(),
    trace_sample_rate: z.number().min(0).max(1).default(1.0),
  })
  .optional();

export const configSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9-_]*$/,
        "name must be lowercase with letters/digits/hyphens/underscores only."
      ),
    version: z.number().int().positive(),
    instance_name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    database: databaseSchema,
    llm: llmSchema,
    router: routerSchema,
    topics: z.array(topicSchema).min(1, "Config must declare at least one topic."),
    policies: policiesSchema,
    hooks: hooksSchema,
    memory: memorySchema,
    observability: observabilitySchema,
  })
  .refine(
    (c) => {
      // Topic names must be unique
      const names = c.topics.map((t) => t.name);
      return new Set(names).size === names.length;
    },
    { message: "Topic names must be unique.", path: ["topics"] }
  );

export type ConvographConfig = z.infer<typeof configSchema>;
