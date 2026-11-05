import { randomUUID } from "node:crypto";

/**
 * Known OpenAI-compatible endpoints. "ollama" runs locally and needs no key,
 * which makes it the last-resort fallback that always works offline.
 */
export const OPENAI_COMPATIBLE_PRESETS = {
  openai: { baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  groq: { baseURL: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  deepseek: { baseURL: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  ollama: { baseURL: "http://localhost:11434/v1", keyEnv: null, defaultKey: "ollama" },
  custom: { baseURL: null, keyEnv: "CODEMENDER_CUSTOM_API_KEY" },
};

class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** Anthropic-style content blocks -> OpenAI chat messages. */
function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const toolCalls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }
    // user turn: may hold tool results and/or text
    const texts = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const content = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("\n");
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${content}` : content });
      } else if (b.type === "text") {
        texts.push(b.text);
      }
    }
    if (texts.length) out.push({ role: "user", content: texts.join("\n") });
  }
  return out;
}

function safeParse(json) {
  try {
    return JSON.parse(json || "{}");
  } catch {
    return { __invalid_json: json };
  }
}

/**
 * options: { provider, model, apiKey?, baseURL?, maxTokens? }
 */
export function createOpenAICompatibleProvider(options = {}) {
  const { provider = "custom", model, maxTokens = 8192 } = options;
  const preset = OPENAI_COMPATIBLE_PRESETS[provider] ?? OPENAI_COMPATIBLE_PRESETS.custom;
  const baseURL = (options.baseURL ?? preset.baseURL ?? process.env.CODEMENDER_CUSTOM_BASE_URL ?? "").replace(/\/$/, "");
  const apiKey = options.apiKey ?? (preset.keyEnv ? process.env[preset.keyEnv] : undefined) ?? preset.defaultKey;

  if (!model && provider !== "ollama") throw new Error(`Provider "${provider}" needs a model name`);
  if (!baseURL) throw new Error(`Provider "${provider}" needs a baseURL`);

  let activeModel = model;

  /**
   * Ollama: if the configured model isn't pulled, fall back to whatever is
   * installed locally so the offline safety net still works.
   */
  async function pickInstalledOllamaModel() {
    const res = await fetch(`${baseURL.replace(/\/v1$/, "")}/api/tags`);
    if (!res.ok) throw new HttpError(res.status, `ollama ${res.status}: could not list models`);
    const data = await res.json();
    const names = (data.models ?? []).map((m) => m.name);
    if (!names.length) throw new HttpError(404, "ollama: no models installed (run `ollama pull qwen2.5-coder:7b`)");
    // Prefer coder models, then the largest by size.
    const coder = names.find((n) => /coder|code|deepseek|qwen/i.test(n));
    return coder ?? (data.models.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]).name;
  }

  const self = {
    id: `${provider}/${model ?? "auto"}`,
    provider,
    get model() {
      return activeModel;
    },
    supportsTools: true,

    async chat(request, _retried = false) {
      if (provider === "ollama" && !activeModel) {
        activeModel = await pickInstalledOllamaModel();
        options.logger?.warn(`ollama: using installed model ${activeModel}`);
      }
      try {
        return await self._chat(request);
      } catch (err) {
        if (provider === "ollama" && err.status === 404 && !_retried) {
          const picked = await pickInstalledOllamaModel();
          if (picked !== activeModel) {
            options.logger?.warn(`ollama: model "${activeModel}" not found, using installed model ${picked}`);
            activeModel = picked;
            self.id = `${provider}/${picked}`;
            return self.chat(request, true);
          }
        }
        throw err;
      }
    },

    async _chat({ system, messages, tools }) {
      const model = activeModel;
      if (!apiKey) {
        const e = new HttpError(401, `No API key for ${provider} (set ${preset.keyEnv})`);
        throw e;
      }
      const body = {
        model,
        max_tokens: maxTokens,
        messages: toOpenAIMessages(system, messages),
      };
      if (tools?.length) {
        body.tools = tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }));
        body.tool_choice = "auto";
      }

      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      };
      if (provider === "openrouter") {
        headers["HTTP-Referer"] = "https://github.com/codemender-ai";
        headers["X-Title"] = "codemender-ai";
      }

      const res = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try {
          msg = JSON.parse(text)?.error?.message ?? text;
        } catch {}
        throw new HttpError(res.status, `${provider} ${res.status}: ${msg}`.slice(0, 500), text);
      }

      const data = JSON.parse(text);
      const choice = data.choices?.[0];
      if (!choice) throw new HttpError(502, `${provider}: empty response`);

      const content = [];
      if (choice.message?.content) content.push({ type: "text", text: choice.message.content });
      for (const tc of choice.message?.tool_calls ?? []) {
        content.push({
          type: "tool_use",
          id: tc.id || `call_${randomUUID()}`,
          name: tc.function?.name,
          input: safeParse(tc.function?.arguments),
        });
      }

      const finish = choice.finish_reason;
      const stopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";

      return {
        content,
        stopReason,
        stopDetails: null,
        usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
        servedBy: data.model ?? model,
      };
    },
  };
  return self;
}
