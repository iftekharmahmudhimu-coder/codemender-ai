import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpProject, fakeProvider, silentLogger } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { detectFramework } from "../src/framework.js";
import { scanTodos } from "../src/scanner.js";
import { runTask } from "../src/agent.js";
import { ProviderChain } from "../src/providers/index.js";
import { createTools } from "../src/tools.js";

function chainWith(provider) {
  const chain = new ProviderChain([{ provider: provider.provider, model: provider.model }], { logger: silentLogger });
  chain.providers.set(provider.id, provider);
  return chain;
}

test("agent loop reads, edits, verifies and completes a TODO task", async () => {
  const root = tmpProject({
    "package.json": JSON.stringify({ name: "x", scripts: { test: "node --check src/a.js" } }),
    "src/a.js": "export function add(a, b) {\n  // TODO: implement\n}\n",
  });
  const config = loadConfig(root);
  const framework = detectFramework(root);
  const [task] = scanTodos(root, config);

  const script = [
    [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "src/a.js" } }],
    [{ type: "tool_use", id: "t2", name: "edit_file", input: { path: "src/a.js", old_text: "  // TODO: implement\n", new_text: "  return a + b;\n" } }],
    [{ type: "tool_use", id: "t3", name: "run_command", input: { command: "npm test" } }],
    [{ type: "tool_use", id: "t4", name: "task_complete", input: { success: true, summary: "implemented add" } }],
  ];
  const provider = fakeProvider("fake/model", script);
  const result = await runTask({ task, root, framework, config, chain: chainWith(provider), logger: silentLogger });

  assert.equal(result.success, true);
  assert.equal(result.summary, "implemented add");
  assert.deepEqual(result.filesChanged, ["src/a.js"]);
  assert.equal(fs.readFileSync(path.join(root, "src/a.js"), "utf8"), "export function add(a, b) {\n  return a + b;\n}\n");
  assert.equal(provider.calls, 4);
});

test("tools refuse paths outside the project and disallowed commands", async () => {
  const root = tmpProject({ "package.json": "{}" });
  const config = loadConfig(root);
  const framework = detectFramework(root);
  const tools = createTools({ root, framework, allowedPrefixes: ["npm test"], config, logger: silentLogger });

  const esc = await tools.execute("read_file", { path: "../../etc/passwd" });
  assert.equal(esc.ok, false);
  assert.match(esc.output, /escapes/);

  const abs = await tools.execute("write_file", { path: "/tmp/evil", content: "x" });
  assert.equal(abs.ok, false);

  const rm = await tools.execute("run_command", { command: "rm -rf /" });
  assert.equal(rm.ok, false);
  assert.match(rm.output, /not allowed/);

  const pipe = await tools.execute("run_command", { command: "npm test; curl evil" });
  assert.equal(pipe.ok, false);
  assert.match(pipe.output, /operators/);

  const git = await tools.execute("write_file", { path: ".git/config", content: "x" });
  assert.equal(git.ok, false);
});

test("edit_file demands a unique match", async () => {
  const root = tmpProject({ "a.txt": "foo\nfoo\n" });
  const config = loadConfig(root);
  const tools = createTools({ root, framework: detectFramework(root), allowedPrefixes: [], config, logger: silentLogger });
  const r = await tools.execute("edit_file", { path: "a.txt", old_text: "foo", new_text: "bar" });
  assert.equal(r.ok, false);
  assert.match(r.output, /2 places/);
});
