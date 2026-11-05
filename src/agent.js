import { createTools } from "./tools.js";
import { allowedCommandPrefixes } from "./framework.js";
import { projectTree } from "./scanner.js";

function buildSystemPrompt({ framework, config, tree, allowedPrefixes }) {
  const cmds = Object.entries(framework.commands)
    .map(([k, v]) => `- ${k}: \`${v}\``)
    .join("\n");

  return `You are Codemender, an autonomous senior software engineer working inside an existing codebase.

PROJECT
- Framework: ${framework.label}
- Languages: ${framework.languages.join(", ") || "unknown"}
${framework.notes.map((n) => `- ${n}`).join("\n")}
- Verification commands available:
${cmds || "- (none detected; verify by reading code carefully)"}

HOW TO WORK
1. Understand before changing: list and read the relevant files first. Follow the project's existing conventions, naming, and style exactly.
2. Make focused changes with edit_file; use write_file for new files. Never rewrite whole files when a small edit will do.
3. After changing code, run the relevant verification command(s) with run_command (tests, lint, type-check). Fix anything that breaks. Do not disable or delete tests to make them pass.
4. Do not modify unrelated code, do not reformat files, do not add dependencies unless the task requires it (and then install them with an allowed command).
5. Keep secrets out of code. Never print or commit .env contents.
6. When the task is fully done and verified, call task_complete with success=true and a concise summary. If it truly cannot be done (missing information, impossible requirement), call task_complete with success=false and say exactly what is missing. Never claim success without verifying.
7. Be efficient: batch related reads, avoid re-reading unchanged files, and finish within the iteration budget.

Allowed command prefixes: ${allowedPrefixes.join(" | ")}

PROJECT FILES (first ${tree.length}):
${tree.join("\n")}`;
}

function describeTask(task) {
  switch (task.type) {
    case "todo":
    case "stub":
      return `TASK TYPE: ${task.type === "stub" ? "Unimplemented stub" : "TODO comment"}

File: ${task.file}, line ${task.line}
Marker: ${task.text}
${task.note ? `Note: ${task.note}\n` : ""}
Surrounding code:
\`\`\`
${task.context}
\`\`\`

Implement what the marker asks for (or what the stub obviously should do, based on its name, callers, tests and surrounding code). Remove the marker once the work is done. If the TODO describes something that genuinely cannot be inferred, implement the most reasonable interpretation that keeps existing behaviour working and note the assumption in a short code comment.`;

    case "issue":
      return `TASK TYPE: Failing ${task.kind}

Command: \`${task.command}\`
Output (tail):
\`\`\`
${task.output}
\`\`\`

Find the root cause and fix the code so this command passes. Fix the underlying problem rather than suppressing the error. Re-run the command to confirm.`;

    case "requirement":
      return `TASK TYPE: Requirement from module "${task.module}"${task.section ? ` / section "${task.section}"` : ""}

Requirement file: ${task.file}
Requirement: ${task.text}
${task.details ? `Details:\n${task.details}\n` : ""}
Full module specification for context (implement ONLY the requirement above in this task; other checklist items are handled separately):
--------
${task.spec.slice(0, 20_000)}
--------

Implement this requirement completely in the codebase: models/migrations, business logic, routes/controllers or endpoints, validation, and tests as appropriate for this framework. Verify with the available commands. Do NOT edit the requirement file itself; the system marks it done when you call task_complete.`;

    default:
      return `TASK: ${task.text}`;
  }
}

/**
 * Run one task to completion with the agent loop.
 *
 * Returns { success, summary, iterations, filesChanged, provider }
 */
export async function runTask({ task, root, framework, config, chain, logger, dryRun = false }) {
  const allowedPrefixes = allowedCommandPrefixes(framework, config);
  const tree = projectTree(root, config);

  let completion = null;
  const tools = createTools({
    root,
    framework,
    allowedPrefixes,
    config,
    logger,
    onTaskDone: (input) => {
      completion = input;
    },
  });

  const system = buildSystemPrompt({ framework, config, tree, allowedPrefixes });
  const messages = [{ role: "user", content: [{ type: "text", text: describeTask(task) }] }];

  if (dryRun) {
    return { success: false, summary: "dry run — not executed", iterations: 0, filesChanged: [], dryRun: true };
  }

  const mutatingTools = new Set(["write_file", "edit_file", "delete_file"]);
  const filesChanged = new Set();
  let iterations = 0;
  let lastProvider = null;

  while (iterations < config.maxIterations) {
    iterations += 1;
    const result = await chain.chat({ system, messages, tools: tools.definitions });
    lastProvider = result.provider;

    if (result.stopReason === "refusal") {
      return { success: false, summary: `Model declined the task (${result.stopDetails?.category ?? "refusal"})`, iterations, filesChanged: [...filesChanged], provider: lastProvider };
    }

    messages.push({ role: "assistant", content: result.content });

    const toolUses = result.content.filter((b) => b.type === "tool_use");
    const texts = result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (texts) logger.debug(`model: ${texts.slice(0, 500)}`);

    if (toolUses.length === 0) {
      if (result.stopReason === "max_tokens") {
        messages.push({ role: "user", content: [{ type: "text", text: "Your response was cut off. Continue, using smaller steps." }] });
        continue;
      }
      // Model ended its turn without calling task_complete: nudge once, then stop.
      if (completion) break;
      messages.push({
        role: "user",
        content: [{ type: "text", text: "If the task is finished and verified, call task_complete now. Otherwise continue working with the tools." }],
      });
      if (iterations >= 3 && messages.filter((m) => m.role === "user").length > 3) {
        const nudges = messages.filter((m) => m.role === "user" && typeof m.content[0]?.text === "string" && m.content[0].text.startsWith("If the task is finished")).length;
        if (nudges >= 2) break;
      }
      continue;
    }

    const toolResults = [];
    for (const call of toolUses) {
      if (call.input?.__invalid_json !== undefined) {
        toolResults.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: "Tool arguments were not valid JSON. Try again." });
        continue;
      }
      logger.debug(`tool ${call.name} ${JSON.stringify(call.input).slice(0, 200)}`);
      const { ok, output } = await tools.execute(call.name, call.input);
      if (ok && mutatingTools.has(call.name) && call.input?.path) filesChanged.add(call.input.path);
      toolResults.push({ type: "tool_result", tool_use_id: call.id, content: output, ...(ok ? {} : { is_error: true }) });
    }
    messages.push({ role: "user", content: toolResults });

    if (completion) break;
  }

  if (!completion) {
    return {
      success: false,
      summary: `Stopped after ${iterations} iterations without task_complete`,
      iterations,
      filesChanged: [...filesChanged],
      provider: lastProvider,
    };
  }

  return {
    success: Boolean(completion.success),
    summary: completion.summary ?? "",
    iterations,
    filesChanged: [...new Set([...filesChanged, ...(completion.files_changed ?? [])])],
    provider: lastProvider,
  };
}
