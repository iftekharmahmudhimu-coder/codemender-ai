/**
 * codemender-ai — programmatic API.
 *
 *   import { createAgent } from "codemender-ai";
 *   const agent = createAgent({ root: process.cwd() });
 *   await agent.run();            // scan + fix + implement
 *   agent.watch();                // keep running on changes
 */
import { run, scan } from "./runner.js";
import { watch } from "./watcher.js";
import { loadConfig, writeDefaultConfig, DEFAULTS, CONFIG_FILE } from "./config.js";
import { detectFramework } from "./framework.js";
import { createLogger } from "./logger.js";
import { createProvider, createProviderChain, ProviderChain, classifyError, AllProvidersFailedError } from "./providers/index.js";
import { runTask } from "./agent.js";
import { scanTodos, scanRequirements, scanIssues, markRequirementDone } from "./scanner.js";

export {
  run,
  scan,
  watch,
  runTask,
  loadConfig,
  writeDefaultConfig,
  DEFAULTS,
  CONFIG_FILE,
  detectFramework,
  createLogger,
  createProvider,
  createProviderChain,
  ProviderChain,
  classifyError,
  AllProvidersFailedError,
  scanTodos,
  scanRequirements,
  scanIssues,
  markRequirementDone,
};

/**
 * Convenience wrapper that binds a root directory and config overrides.
 */
export function createAgent(options = {}) {
  const base = { root: options.root ?? process.cwd(), config: options.config ?? {}, logger: options.logger };
  return {
    scan: (o = {}) => scan({ ...base, ...o }),
    run: (o = {}) => run({ ...base, ...o }),
    fix: (o = {}) => run({ ...base, only: ["issues"], ...o }),
    completeTodos: (o = {}) => run({ ...base, only: ["todos"], ...o }),
    implementRequirements: (o = {}) => run({ ...base, only: ["requirements"], ...o }),
    watch: (o = {}) => watch({ ...base, ...o }),
    /**
     * Run the agent on a schedule inside a long-lived Node process
     * (e.g. an Express/Nest server). Returns a stop() function.
     */
    schedule: (intervalMs = 15 * 60 * 1000, o = {}) => {
      let busy = false;
      const tick = async () => {
        if (busy) return;
        busy = true;
        try {
          await run({ ...base, ...o });
        } catch (err) {
          (base.logger ?? console).error?.(err.message ?? err);
        } finally {
          busy = false;
        }
      };
      const id = setInterval(tick, intervalMs);
      if (o.runImmediately) tick();
      return () => clearInterval(id);
    },
  };
}

export default createAgent;
