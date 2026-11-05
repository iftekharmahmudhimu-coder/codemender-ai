import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createMatcher } from "./scanner.js";
import { run } from "./runner.js";

/**
 * Watch the project and run the agent whenever source or requirement files
 * change. Runs are serialized; changes made by the agent itself are ignored
 * while a run is in progress.
 */
export function watch(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const config = loadConfig(root, options.config ?? {});
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const matcher = createMatcher(config.include, config.exclude);

  let timer = null;
  let running = false;
  let pending = false;

  const trigger = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await run({ ...options, root, logger });
    } catch (err) {
      logger.error(err.message);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(trigger, config.watch.debounceMs);
  };

  logger.info(`Watching ${root} (debounce ${config.watch.debounceMs}ms). Ctrl+C to stop.`);
  const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.toString().split(path.sep).join("/");
    if (running) return;
    if (!matcher(rel) && !rel.startsWith(`${config.requirementsDir}/`)) return;
    logger.debug(`change: ${rel}`);
    schedule();
  });

  if (options.runImmediately !== false) schedule();

  return {
    close() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}
