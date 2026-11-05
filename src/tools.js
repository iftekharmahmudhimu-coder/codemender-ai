import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createMatcher, walk } from "./scanner.js";

/**
 * Tool definitions (JSON Schema) and their executors. The schema is sent to
 * the model as-is for Anthropic and converted to OpenAI function format for
 * other providers.
 */
export function createTools({ root, framework, allowedPrefixes, config, logger, onTaskDone }) {
  const matcher = createMatcher(config.include, config.exclude);

  /** Resolve a model-supplied path and refuse anything outside the project. */
  function resolveSafe(rel) {
    if (typeof rel !== "string" || !rel.trim()) throw new Error("path is required");
    const target = path.resolve(root, rel);
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new Error(`path escapes the project root: ${rel}`);
    }
    // Follow symlinks for existing paths.
    let real = target;
    try {
      real = fs.realpathSync(target);
    } catch {
      try {
        real = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
      } catch {}
    }
    const realRoot = fs.realpathSync(root);
    if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
      throw new Error(`path escapes the project root (symlink): ${rel}`);
    }
    if (/(^|\/)\.git(\/|$)/.test(relative.split(path.sep).join("/"))) throw new Error("refusing to touch .git");
    return target;
  }

  const definitions = [
    {
      name: "list_files",
      description: "List project files (relative paths) under an optional directory, honouring the project's exclude rules. Use this to orient yourself before reading or editing.",
      input_schema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Directory relative to project root. Default: project root." },
          max: { type: "integer", description: "Maximum number of entries (default 300)." },
        },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: "read_file",
      description: "Read a text file. Returns the content with line numbers so you can reference exact lines in edits.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", description: "1-based first line to return (optional)." },
          end_line: { type: "integer", description: "1-based last line to return (optional)." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "write_file",
      description: "Create or completely overwrite a file with the given content. Parent directories are created. Prefer edit_file for small changes to existing files.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "edit_file",
      description: "Replace an exact, unique snippet of text in a file with new text. old_text must appear exactly once. Use this for targeted changes.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_file",
      description: "Delete a file. Only use when a task explicitly calls for removing it.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "search",
      description: "Search project files for a regular expression (case-insensitive). Returns matching lines as path:line: text.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression." },
          dir: { type: "string", description: "Limit to this directory (optional)." },
          max: { type: "integer", description: "Max matches (default 100)." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    {
      name: "run_command",
      description:
        `Run a shell command in the project root and return its output. Only verification and scaffolding commands are allowed. Allowed prefixes: ${allowedPrefixes.map((p) => `"${p.trim()}"`).join(", ")}. Use this to run tests/lint after changes.`,
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: { type: "integer", description: "Default 300." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "task_complete",
      description:
        "Call this exactly once when the current task is fully done and verified (tests/lint pass where available). Give a short summary of what you changed. If the task cannot be completed, set success=false and explain why.",
      input_schema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          summary: { type: "string" },
          files_changed: { type: "array", items: { type: "string" } },
        },
        required: ["success", "summary"],
        additionalProperties: false,
      },
    },
  ];

  const executors = {
    list_files({ dir = "", max = 300 }) {
      const base = dir ? resolveSafe(dir) : root;
      const relBase = path.relative(root, base).split(path.sep).join("/");
      const out = [];
      for (const rel of walk(root, matcher, relBase || "")) {
        out.push(rel);
        if (out.length >= max) break;
      }
      return out.length ? out.join("\n") : "(no files)";
    },

    read_file({ path: p, start_line, end_line }) {
      const abs = resolveSafe(p);
      if (!fs.existsSync(abs)) return `ERROR: file not found: ${p}`;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return `ERROR: ${p} is a directory`;
      if (stat.size > 2 * 1024 * 1024) return `ERROR: file too large (${stat.size} bytes)`;
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      const s = Math.max(1, start_line ?? 1);
      const e = Math.min(lines.length, end_line ?? lines.length);
      const width = String(e).length;
      const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(width)}| ${l}`).join("\n");
      return `${p} (${lines.length} lines)\n${body}`;
    },

    write_file({ path: p, content }) {
      const abs = resolveSafe(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const existed = fs.existsSync(abs);
      fs.writeFileSync(abs, content);
      logger?.info(`${existed ? "updated" : "created"} ${p}`);
      return `${existed ? "Overwrote" : "Created"} ${p} (${content.split("\n").length} lines)`;
    },

    edit_file({ path: p, old_text, new_text }) {
      const abs = resolveSafe(p);
      if (!fs.existsSync(abs)) return `ERROR: file not found: ${p}`;
      const text = fs.readFileSync(abs, "utf8");
      const count = text.split(old_text).length - 1;
      if (count === 0) return `ERROR: old_text not found in ${p}. Read the file again and copy the snippet exactly.`;
      if (count > 1) return `ERROR: old_text matches ${count} places in ${p}; include more surrounding context to make it unique.`;
      fs.writeFileSync(abs, text.replace(old_text, () => new_text));
      logger?.info(`edited ${p}`);
      return `Edited ${p}`;
    },

    delete_file({ path: p }) {
      const abs = resolveSafe(p);
      if (!fs.existsSync(abs)) return `ERROR: file not found: ${p}`;
      fs.rmSync(abs);
      logger?.info(`deleted ${p}`);
      return `Deleted ${p}`;
    },

    search({ pattern, dir = "", max = 100 }) {
      let re;
      try {
        re = new RegExp(pattern, "i");
      } catch (err) {
        return `ERROR: invalid regex: ${err.message}`;
      }
      const relBase = dir ? path.relative(root, resolveSafe(dir)).split(path.sep).join("/") : "";
      const hits = [];
      outer: for (const rel of walk(root, matcher, relBase)) {
        let text;
        try {
          if (fs.statSync(path.join(root, rel)).size > 1024 * 1024) continue;
          text = fs.readFileSync(path.join(root, rel), "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (hits.length >= max) break outer;
          }
        }
      }
      return hits.length ? hits.join("\n") : "(no matches)";
    },

    run_command({ command, timeout_seconds = 300 }) {
      const cmd = String(command ?? "").trim();
      if (!cmd) return "ERROR: command is required";
      if (/[;&|`$><]/.test(cmd.replace(/--?[\w-]+=("[^"]*"|'[^']*')/g, ""))) {
        return "ERROR: shell operators (; & | ` $ > <) are not allowed. Run one plain command at a time.";
      }
      const ok = allowedPrefixes.some((p) => cmd === p.trim() || cmd.startsWith(p));
      if (!ok) return `ERROR: command not allowed: "${cmd}". Allowed prefixes: ${allowedPrefixes.join(" | ")}`;
      logger?.info(`$ ${cmd}`);
      const [bin, ...args] = splitArgs(cmd);
      const res = spawnSync(bin, args, {
        cwd: root,
        encoding: "utf8",
        timeout: Math.min(timeout_seconds, 900) * 1000,
        env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
        maxBuffer: 16 * 1024 * 1024,
      });
      if (res.error) return `ERROR: ${res.error.message}`;
      const out = `${res.stdout ?? ""}${res.stderr ? "\n[stderr]\n" + res.stderr : ""}`.trim();
      const tail = out.length > 20_000 ? "…(truncated)…\n" + out.slice(-20_000) : out;
      return `exit code: ${res.status}\n${tail || "(no output)"}`;
    },

    task_complete(input) {
      onTaskDone?.(input);
      return "Recorded. Stop now.";
    },
  };

  async function execute(name, input) {
    const fn = executors[name];
    if (!fn) return { ok: false, output: `ERROR: unknown tool ${name}` };
    try {
      const output = await fn(input ?? {});
      return { ok: !String(output).startsWith("ERROR:"), output: String(output) };
    } catch (err) {
      return { ok: false, output: `ERROR: ${err.message}` };
    }
  }

  return { definitions, execute };
}

/** Minimal shell-like argument splitter supporting quotes. */
export function splitArgs(cmd) {
  const args = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (/\s/.test(c)) {
      if (cur) args.push(cur), (cur = "");
    } else cur += c;
  }
  if (cur) args.push(cur);
  return args;
}
