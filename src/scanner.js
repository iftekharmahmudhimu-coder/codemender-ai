import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const TEXT_EXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte", ".php", ".blade.php", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".cs", ".swift", ".dart", ".html", ".css", ".scss", ".sql", ".md", ".json", ".yml", ".yaml", ".env.example",
]);

const TODO_PATTERNS = [
  { re: /\b(TODO|FIXME|HACK|XXX|UNFINISHED|INCOMPLETE)\b[:\s-]*(.*)/i, kind: "todo" },
  { re: /throw new (Error|\\?Exception|NotImplementedException|RuntimeException)\((['"`])(not implemented|todo|unimplemented)[^'"`]*\2\)/i, kind: "stub" },
  { re: /\bNotImplementedError\b|\braise NotImplementedError\b/i, kind: "stub" },
  { re: /\bunimplemented!\(|\btodo!\(/, kind: "stub" },
  { re: /\/\/\s*\.\.\.\s*$|#\s*\.\.\.\s*$|^\s*pass\s*#\s*(todo|later|implement)/i, kind: "stub" },
  { re: /@(todo|incomplete|fixme)\b\s*(.*)/i, kind: "todo" },
];

/* ------------------------------------------------------------------ */
/* glob helpers (no deps)                                               */
/* ------------------------------------------------------------------ */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // "a/**/b" matches a/b and a/x/y/b
        } else {
          re += ".*"; // trailing "dir/**" matches everything below dir
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function createMatcher(include = ["**/*"], exclude = []) {
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  const norm = (rel) => rel.split(path.sep).join("/");
  const isExcluded = (rel) => exc.some((r) => r.test(norm(rel)));
  const matcher = (rel) => {
    rel = norm(rel);
    if (isExcluded(rel)) return false;
    return inc.some((r) => r.test(rel));
  };
  // Directories are pruned only by exclude rules, never by include rules,
  // so "src/**/*.js" still descends into src/a/b/.
  matcher.isExcludedDir = (rel) => isExcluded(rel) || isExcluded(norm(rel) + "/x");
  return matcher;
}

export function* walk(root, matcher, rel = "") {
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (matcher.isExcludedDir?.(r)) continue; // prune excluded dirs early
      yield* walk(root, matcher, r);
    } else if (e.isFile() && matcher(r)) {
      yield r;
    }
  }
}

function isTextFile(rel) {
  const base = path.basename(rel);
  if (base.endsWith(".blade.php")) return true;
  return TEXT_EXT.has(path.extname(rel)) || base === ".env.example";
}

/* ------------------------------------------------------------------ */
/* TODO / stub scan                                                     */
/* ------------------------------------------------------------------ */
export function scanTodos(root, config) {
  const matcher = createMatcher(config.include, config.exclude);
  const found = [];
  for (const rel of walk(root, matcher)) {
    if (!isTextFile(rel)) continue;
    if (rel.startsWith(`${config.requirementsDir}/`)) continue;
    let text;
    try {
      const stat = fs.statSync(path.join(root, rel));
      if (stat.size > 512 * 1024) continue;
      text = fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const { re, kind } of TODO_PATTERNS) {
        const m = line.match(re);
        if (!m) continue;
        // skip our own pattern definitions / docs about TODOs
        if (/TODO_PATTERNS|scanTodos/.test(line)) continue;
        found.push({
          id: `todo:${rel}:${i + 1}`,
          type: kind,
          file: rel,
          line: i + 1,
          text: line.trim().slice(0, 200),
          note: (m[2] ?? m[3] ?? "").trim().slice(0, 200),
          context: lines.slice(Math.max(0, i - 3), i + 4).join("\n"),
        });
        break;
      }
    });
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Requirements                                                         */
/* ------------------------------------------------------------------ */
const CHECKBOX = /^(\s*[-*+]\s*\[)( |x|X)(\]\s*)(.*)$/;

export function scanRequirements(root, config) {
  const dir = path.join(root, config.requirementsDir);
  if (!fs.existsSync(dir)) return { modules: [], tasks: [] };

  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(md|markdown|txt)$/i.test(f))
    .sort();

  const modules = [];
  const tasks = [];

  for (const file of files) {
    const rel = `${config.requirementsDir}/${file}`;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const lines = text.split("\n");
    const title = (lines.find((l) => /^#\s+/.test(l)) ?? "").replace(/^#\s+/, "").trim() || path.basename(file, path.extname(file));
    const mod = { name: title, file: rel, total: 0, done: 0 };

    let section = "";
    let sawCheckbox = false;
    lines.forEach((line, i) => {
      if (/^#{2,}\s+/.test(line)) section = line.replace(/^#+\s+/, "").trim();
      const m = line.match(CHECKBOX);
      if (!m) return;
      sawCheckbox = true;
      const done = m[2].toLowerCase() === "x";
      mod.total++;
      if (done) mod.done++;
      else {
        // Grab indented detail lines that follow the item.
        const details = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s+(?![-*+]\s*\[)/.test(lines[j]) && lines[j].trim()) details.push(lines[j].trim());
          else if (!lines[j].trim()) continue;
          else break;
        }
        tasks.push({
          id: `req:${rel}:${i + 1}`,
          type: "requirement",
          module: title,
          section,
          file: rel,
          line: i + 1,
          text: m[4].trim(),
          details: details.join("\n"),
          spec: text,
        });
      }
    });

    if (!sawCheckbox) {
      // Whole file is a single requirement unless it's marked done.
      const done = /^\s*(status|state)\s*:\s*(done|complete|completed)/im.test(text) || /<!--\s*codemender:done\s*-->/.test(text);
      mod.total = 1;
      mod.done = done ? 1 : 0;
      if (!done) {
        tasks.push({
          id: `req:${rel}:*`,
          type: "requirement",
          module: title,
          section: "",
          file: rel,
          line: 0,
          text: `Implement everything described in ${rel}`,
          details: "",
          spec: text,
        });
      }
    }
    modules.push(mod);
  }
  return { modules, tasks };
}

/**
 * Mark a requirement task done in its markdown file. For checkbox tasks this
 * flips "[ ]" -> "[x]"; for whole-file tasks it appends a marker comment.
 */
export function markRequirementDone(root, task) {
  const abs = path.join(root, task.file);
  if (!fs.existsSync(abs)) return false;
  let text = fs.readFileSync(abs, "utf8");
  if (task.line > 0) {
    const lines = text.split("\n");
    const idx = task.line - 1;
    const m = lines[idx]?.match(CHECKBOX);
    if (!m) {
      // line shifted — search by text
      const alt = lines.findIndex((l) => l.match(CHECKBOX) && l.includes(task.text));
      if (alt === -1) return false;
      lines[alt] = lines[alt].replace(CHECKBOX, "$1x$3$4");
    } else {
      lines[idx] = lines[idx].replace(CHECKBOX, "$1x$3$4");
    }
    text = lines.join("\n");
  } else {
    if (!/<!--\s*codemender:done\s*-->/.test(text)) text = text.trimEnd() + "\n\n<!-- codemender:done -->\n";
  }
  fs.writeFileSync(abs, text);
  return true;
}

/* ------------------------------------------------------------------ */
/* Issues: run verification commands and capture failures              */
/* ------------------------------------------------------------------ */
export function scanIssues(root, framework, config, logger) {
  const issues = [];
  const order = ["lint", "typecheck", "test"];
  for (const kind of order) {
    const cmd = framework.commands[kind];
    if (!cmd) continue;
    logger?.debug(`running ${kind}: ${cmd}`);
    try {
      execSync(cmd, { cwd: root, stdio: "pipe", timeout: config.commandTimeoutMs ?? 300_000, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    } catch (err) {
      const out = `${err.stdout?.toString() ?? ""}\n${err.stderr?.toString() ?? ""}`.trim();
      if (err.code === "ENOENT" || /command not found|not recognized/i.test(out)) {
        logger?.debug(`${kind} command unavailable: ${cmd}`);
        continue;
      }
      issues.push({
        id: `issue:${kind}`,
        type: "issue",
        kind,
        command: cmd,
        text: `${kind} command failed: ${cmd}`,
        output: out.slice(-12_000),
      });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Project tree summary for the system prompt                           */
/* ------------------------------------------------------------------ */
export function projectTree(root, config, limit = 400) {
  const matcher = createMatcher(config.include, config.exclude);
  const files = [];
  for (const rel of walk(root, matcher)) {
    files.push(rel);
    if (files.length >= limit) break;
  }
  return files;
}
