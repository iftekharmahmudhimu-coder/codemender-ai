import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { detectFramework } from "./framework.js";
import { scanTodos, scanRequirements, scanIssues, markRequirementDone } from "./scanner.js";
import { createProviderChain } from "./providers/index.js";
import { runTask } from "./agent.js";

/* ------------------------------------------------------------------ */
/* state                                                                */
/* ------------------------------------------------------------------ */
function loadState(config) {
  const file = path.join(config.stateDir, "state.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { completed: {}, failed: {}, runs: [] };
  }
}

function saveState(config, state) {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(path.join(config.stateDir, "state.json"), JSON.stringify(state, null, 2));
  const gi = path.join(config.stateDir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n!.gitignore\n");
}

/* ------------------------------------------------------------------ */
/* git helpers                                                          */
/* ------------------------------------------------------------------ */
function git(root, args) {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: "pipe", encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function markerStillPresent(root, task) {
  try {
    const text = fs.readFileSync(path.join(root, task.file), "utf8");
    return text.includes(task.text);
  } catch {
    return false;
  }
}

function isGitRepo(root) {
  return git(root, "rev-parse --is-inside-work-tree") === "true";
}

/* ------------------------------------------------------------------ */
/* scan                                                                 */
/* ------------------------------------------------------------------ */
export function scan({ root = process.cwd(), config: overrides = {}, logger, runChecks = true } = {}) {
  const config = loadConfig(root, overrides);
  logger ??= createLogger({ level: config.logLevel });
  const framework = detectFramework(config.root);

  const todos = config.tasks.todos ? scanTodos(config.root, config) : [];
  const requirements = config.tasks.requirements ? scanRequirements(config.root, config) : { modules: [], tasks: [] };
  const issues = config.tasks.issues && runChecks ? scanIssues(config.root, framework, config, logger) : [];

  return { config, framework, todos, requirements, issues };
}

/* ------------------------------------------------------------------ */
/* run                                                                  */
/* ------------------------------------------------------------------ */
/**
 * Scan the project and work through the tasks found.
 *
 * options:
 *   root, config (overrides), only: ["todos"|"issues"|"requirements"],
 *   dryRun, limit, logger, onTask(task, result)
 */
export async function run(options = {}) {
  const { root = process.cwd(), only, dryRun = false, onTask } = options;
  const config = loadConfig(root, options.config ?? {});
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const framework = detectFramework(config.root);
  const state = loadState(config);

  logger.info(`Project: ${config.root}`);
  logger.info(`Framework: ${framework.label}`);
  logger.info(`Model: ${config.provider}/${config.model}  fallbacks: ${(config.fallbacks ?? []).map((f) => `${f.provider}/${f.model}`).join(", ") || "none"}`);

  if (config.git.requireCleanTree && isGitRepo(config.root) && git(config.root, "status --porcelain")) {
    throw new Error("Working tree is not clean and git.requireCleanTree is set. Commit or stash first.");
  }

  const want = (kind) => !only?.length || only.includes(kind);

  // Requirements first (new work), then failing checks, then TODOs.
  const requirements = want("requirements") && config.tasks.requirements ? scanRequirements(config.root, config) : { modules: [], tasks: [] };
  const issues = want("issues") && config.tasks.issues ? scanIssues(config.root, framework, config, logger) : [];
  const todos = want("todos") && config.tasks.todos ? scanTodos(config.root, config) : [];

  let tasks = [...requirements.tasks, ...issues, ...todos].filter((t) => {
    const f = state.failed[t.id];
    return !(f && f.attempts >= 3); // give up after three failed attempts
  });

  const limit = options.limit ?? config.maxTasksPerRun;
  const skipped = Math.max(0, tasks.length - limit);
  tasks = tasks.slice(0, limit);

  logger.info(`Found ${requirements.tasks.length} requirement(s), ${issues.length} failing check(s), ${todos.length} TODO/stub(s)${skipped ? `; ${skipped} deferred to the next run` : ""}`);

  if (tasks.length === 0) {
    logger.success("Nothing to do.");
    return { tasks: [], results: [], usage: null, switches: [] };
  }

  if (dryRun) {
    for (const t of tasks) logger.raw(`  • [${t.type}] ${t.file ?? t.command}${t.line ? `:${t.line}` : ""}  ${t.text}\n`);
    return { tasks, results: [], usage: null, switches: [], dryRun: true };
  }

  const chain = createProviderChain(config, logger);
  const results = [];
  const runRecord = { startedAt: new Date().toISOString(), tasks: [] };

  for (const [i, task] of tasks.entries()) {
    // An earlier task may already have resolved this marker.
    if ((task.type === "todo" || task.type === "stub") && !markerStillPresent(config.root, task)) {
      logger.info(`[${i + 1}/${tasks.length}] skip ${task.id}: already resolved`);
      continue;
    }
    logger.step(`[${i + 1}/${tasks.length}] ${task.type}: ${task.text.slice(0, 120)}`);
    let result;
    try {
      result = await runTask({ task, root: config.root, framework, config, chain, logger });
    } catch (err) {
      if (err.name === "AllProvidersFailedError") {
        logger.error(err.message);
        results.push({ task, result: { success: false, summary: err.message, fatal: true } });
        break;
      }
      result = { success: false, summary: err.message, iterations: 0, filesChanged: [] };
      logger.error(`task failed: ${err.message}`);
    }

    if (result.success) {
      logger.success(`${task.id}: ${result.summary.slice(0, 200)}`);
      state.completed[task.id] = { at: new Date().toISOString(), summary: result.summary };
      delete state.failed[task.id];
      if (task.type === "requirement") markRequirementDone(config.root, task);
      if (config.git.autoCommit && isGitRepo(config.root)) {
        git(config.root, "add -A -- . ':!.codemender'");
        if (git(config.root, "diff --cached --quiet") === null) {
          const msg = `codemender: ${task.type} — ${task.text.slice(0, 60).replace(/"/g, "'")}`;
          git(config.root, `commit -q -m "${msg}" -m "${result.summary.replace(/"/g, "'").slice(0, 500)}"`);
          logger.info("committed");
        } else {
          logger.info("nothing to commit");
        }
      }
    } else {
      logger.warn(`${task.id}: ${result.summary.slice(0, 200)}`);
      const f = (state.failed[task.id] ??= { attempts: 0 });
      f.attempts += 1;
      f.last = result.summary;
      f.at = new Date().toISOString();
    }

    results.push({ task, result });
    runRecord.tasks.push({ id: task.id, success: result.success, provider: result.provider, iterations: result.iterations });
    onTask?.(task, result);
    saveState(config, state);
  }

  runRecord.finishedAt = new Date().toISOString();
  runRecord.usage = chain.usage;
  runRecord.switches = chain.switches;
  state.runs = [...(state.runs ?? []).slice(-49), runRecord];
  saveState(config, state);

  const ok = results.filter((r) => r.result.success).length;
  logger.info(`Done: ${ok}/${results.length} task(s) completed. Tokens in/out: ${chain.usage.input}/${chain.usage.output}`);
  for (const s of chain.switches) logger.info(`model switch: ${s.from} -> ${s.to} (${s.reason})`);

  return { tasks, results, usage: chain.usage, switches: chain.switches };
}
