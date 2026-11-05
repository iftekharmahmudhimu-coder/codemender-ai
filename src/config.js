import fs from "node:fs";
import path from "node:path";

export const CONFIG_FILE = "codemender.config.json";
export const STATE_DIR = ".codemender";

/**
 * Default configuration. Everything here can be overridden by
 * codemender.config.json in the project root, then by environment
 * variables, then by CLI flags / programmatic options.
 */
export const DEFAULTS = {
  // Primary model. "anthropic" uses the official @anthropic-ai/sdk.
  provider: "anthropic",
  model: "claude-opus-5-5",
  effort: "high", // low | medium | high | xhigh | max (Anthropic only)

  // Where to go when the primary provider runs out of tokens / credit,
  // is rate limited, or when the local token budget below is exhausted.
  // Tried in order. Providers: anthropic | openai | openrouter | groq | ollama | custom
  fallbacks: [
    { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" },
    { provider: "ollama", model: "qwen2.5-coder:7b" },
  ],

  // Local token budget for the primary provider per run (0 = unlimited).
  // When input+output tokens for this run exceed it, the chain switches
  // to the fallbacks for the rest of the run.
  budget: { maxTokensPerRun: 0 },

  // Module-wise requirement files. Each *.md file is one module; checklist
  // items ("- [ ] ...") are tasks. Files without checkboxes are one task.
  requirementsDir: "requirements",

  // What to look for during a scan.
  tasks: {
    todos: true, // TODO / FIXME / HACK / XXX / "not implemented" stubs
    issues: true, // failing lint / tests / type checks
    requirements: true,
  },

  // Files to consider. Globs are matched against project-relative paths.
  include: ["**/*"],
  exclude: [
    "node_modules/**", "vendor/**", ".git/**", "dist/**", "build/**", "storage/**",
    "bootstrap/cache/**", "public/build/**", ".next/**", "coverage/**", "*.lock",
    "package-lock.json", "composer.lock", "*.min.js", "*.map", ".codemender/**",
  ],

  // Commands the agent may run, in addition to the ones detected from
  // the framework (test / lint / build). Anything else is refused.
  allowedCommands: [],

  // Agent loop limits.
  maxIterations: 60, // tool-call rounds per task
  maxTasksPerRun: 20,
  commandTimeoutMs: 300_000,

  // Git behaviour.
  git: { autoCommit: false, requireCleanTree: false },

  // Watch mode.
  watch: { debounceMs: 2000 },

  logLevel: "info",
};

const ENV_MAP = {
  CODEMENDER_PROVIDER: "provider",
  CODEMENDER_MODEL: "model",
  CODEMENDER_EFFORT: "effort",
  CODEMENDER_REQUIREMENTS_DIR: "requirementsDir",
  CODEMENDER_LOG_LEVEL: "logLevel",
  CODEMENDER_MAX_TOKENS_PER_RUN: "budget.maxTokensPerRun",
};

function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
  cur[parts.at(-1)] = value;
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== "object" || base === null) return override ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig(root = process.cwd(), overrides = {}) {
  root = path.resolve(root);
  let fileConfig = {};
  const file = path.join(root, CONFIG_FILE);
  if (fs.existsSync(file)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`Invalid ${CONFIG_FILE}: ${err.message}`);
    }
  }

  let config = deepMerge(DEFAULTS, fileConfig);

  for (const [env, key] of Object.entries(ENV_MAP)) {
    if (process.env[env] !== undefined && process.env[env] !== "") {
      const raw = process.env[env];
      setPath(config, key, /^\d+$/.test(raw) ? Number(raw) : raw);
    }
  }

  config = deepMerge(config, overrides);
  config.root = root;
  config.stateDir = path.join(root, STATE_DIR);
  return config;
}

export function writeDefaultConfig(root, extra = {}) {
  const file = path.join(root, CONFIG_FILE);
  if (fs.existsSync(file)) return { file, created: false };
  const { root: _r, stateDir: _s, ...rest } = deepMerge(DEFAULTS, extra);
  fs.writeFileSync(file, JSON.stringify(rest, null, 2) + "\n");
  return { file, created: true };
}

/** Which env var holds the API key for a provider. */
export function apiKeyEnvFor(provider) {
  return {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    ollama: null,
    custom: "CODEMENDER_CUSTOM_API_KEY",
  }[provider] ?? null;
}
