import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic adapter. Speaks the native Messages API, so the agent's
 * internal message format *is* the Anthropic format and nothing needs
 * converting here.
 *
 * options: { model, apiKey?, baseURL?, effort?, serverFallback? }
 */
export function createAnthropicProvider(options = {}) {
  const {
    model = "claude-opus-5-5",
    apiKey,
    baseURL,
    effort = "high",
    serverFallback = true,
    maxTokens = 16000,
  } = options;

  const client = new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    maxRetries: 2,
  });

  // Claude 5-generation models accept output_config.effort. Older IDs don't,
  // so only send it where we know it works.
  const supportsEffort = /claude-(opus|sonnet|haiku|fable)-(4-[6-9]|5)/.test(model);
  // Server-side refusal fallbacks exist for the 5-generation models.
  const supportsServerFallback = /claude-(opus-5|sonnet-5|fable-5)/.test(model);

  return {
    id: `anthropic/${model}`,
    provider: "anthropic",
    model,
    supportsTools: true,

    async chat({ system, messages, tools }) {
      const params = {
        model,
        max_tokens: maxTokens,
        system,
        messages,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
        ...(supportsEffort ? { output_config: { effort } } : {}),
      };

      let response;
      if (serverFallback && supportsServerFallback) {
        response = await client.beta.messages.create({
          ...params,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
      } else {
        response = await client.messages.create(params);
      }

      return {
        content: response.content,
        stopReason: response.stop_reason,
        stopDetails: response.stop_details ?? null,
        usage: {
          input: (response.usage?.input_tokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0),
          output: response.usage?.output_tokens ?? 0,
        },
        servedBy: response.model,
      };
    },
  };
}
