import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpProject } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { scanTodos, scanRequirements, markRequirementDone, createMatcher } from "../src/scanner.js";
import { detectFramework } from "../src/framework.js";

test("finds TODOs and stubs but skips excluded dirs", () => {
  const root = tmpProject({
    "src/a.js": "// TODO: handle null\nfunction f() { throw new Error('Not implemented'); }\n",
    "node_modules/x/index.js": "// TODO: ignored\n",
    "app/Http/Controllers/UserController.php": "<?php\n// FIXME validate input\n",
  });
  const config = loadConfig(root);
  const todos = scanTodos(root, config);
  const files = todos.map((t) => `${t.file}:${t.line}`).sort();
  assert.deepEqual(files, ["app/Http/Controllers/UserController.php:2", "src/a.js:1", "src/a.js:2"]);
  assert.equal(todos.find((t) => t.line === 2 && t.file === "src/a.js").type, "stub");
});

test("parses requirement checklists and marks items done", () => {
  const root = tmpProject({
    "requirements/users.md": "# Users\n\n## API\n- [x] list users\n- [ ] create user\n    POST /users with validation\n- [ ] delete user\n",
    "requirements/notes.md": "# Billing\nImplement invoices.\n",
  });
  const config = loadConfig(root);
  const { modules, tasks } = scanRequirements(root, config);
  assert.equal(modules.length, 2);
  assert.deepEqual(modules.map((m) => [m.name, m.done, m.total]), [["Billing", 0, 1], ["Users", 1, 3]]);
  assert.equal(tasks.length, 3);
  const create = tasks.find((t) => t.text === "create user");
  assert.equal(create.section, "API");
  assert.match(create.details, /POST \/users/);

  assert.ok(markRequirementDone(root, create));
  assert.match(fs.readFileSync(path.join(root, "requirements/users.md"), "utf8"), /- \[x\] create user/);

  const whole = tasks.find((t) => t.module === "Billing");
  assert.ok(markRequirementDone(root, whole));
  assert.equal(scanRequirements(root, config).tasks.length, 1);
});

test("detects Laravel and Node frameworks", () => {
  const laravel = tmpProject({ artisan: "", "composer.json": "{}", "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { vue: "3" } }) });
  const f = detectFramework(laravel);
  assert.equal(f.name, "laravel");
  assert.equal(f.commands.test, "php artisan test");
  assert.equal(f.commands.build, "npm run build");
  assert.match(f.label, /Vue/);

  const node = tmpProject({ "package.json": JSON.stringify({ scripts: { test: "vitest" }, dependencies: { express: "4" } }), "tsconfig.json": "{}" });
  const n = detectFramework(node);
  assert.equal(n.name, "node");
  assert.match(n.label, /Express \(TypeScript\)/);
  assert.equal(n.commands.typecheck, "npx tsc --noEmit");
});

test("glob matcher", () => {
  const m = createMatcher(["**/*"], ["node_modules/**", "*.lock", "dist/**"]);
  assert.equal(m("src/x.js"), true);
  assert.equal(m("node_modules/a/b.js"), false);
  assert.equal(m("yarn.lock"), false);
  assert.equal(m("dist/app.js"), false);
});
