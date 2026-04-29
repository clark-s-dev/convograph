/**
 * LLM client factory.
 *
 * Translates an `agent.yaml` `llm:` section into an AI SDK
 * OpenAI-compatible provider, with sensible defaults for known
 * providers (nvidia → integrate.api.nvidia.com).
 *
 * Returns a small wrapper that includes the registered provider name —
 * downstream code (e.g. streamStructured) needs the name to attach
 * provider-specific options like `response_format`.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ConvographConfig } from "../config";

export interface ConvographLlmClient {
  /** AI SDK OpenAI-compatible provider object. */
  provider: ReturnType<typeof createOpenAICompatible>;
  /** Provider name as registered with createOpenAICompatible (used for providerOptions keys). */
  name: string;
  /** Convenience: get a chat-completion LanguageModel by id. */
  chatModel(modelId: string): ReturnType<
    ReturnType<typeof createOpenAICompatible>["chatModel"]
  >;
}

export function createLlmClient(
  llmConfig: ConvographConfig["llm"]
): ConvographLlmClient {
  const baseURL = llmConfig.base_url ?? defaultBaseUrl(llmConfig.provider);
  const provider = createOpenAICompatible({
    name: llmConfig.provider,
    baseURL,
    apiKey: llmConfig.api_key,
  });
  return {
    provider,
    name: llmConfig.provider,
    chatModel: (id: string) => provider.chatModel(id),
  };
}

function defaultBaseUrl(providerName: string): string {
  switch (providerName) {
    case "nvidia":
      return "https://integrate.api.nvidia.com/v1";
    case "openai-compatible":
      throw new Error(
        "[convograph] llm.provider='openai-compatible' requires an explicit `llm.base_url` in agent.yaml."
      );
    default:
      throw new Error(
        `[convograph] Unknown llm.provider ${JSON.stringify(providerName)} — supply an explicit \`llm.base_url\`.`
      );
  }
}
