import fs from "node:fs";
import path from "node:path";

const exists = (root, rel) => fs.existsSync(path.join(root, rel));

function readJson(root, rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Detects the project's framework(s) and derives the commands the agent is
 * allowed to run for verification (tests, lint, type-check, build).
 *
 * Returns { name, label, languages, commands: {test, lint, typecheck, build}, notes }
 */
export function detectFramework(root) {
  const result = {
    name: "generic",
    label: "Generic project",
    languages: [],
    commands: {},
    notes: [],
  };

  const pkg = readJson(root, "package.json");
  const composer = readJson(root, "composer.json");

  // ---- PHP / Laravel ----------------------------------------------------
  if (exists(root, "artisan") && composer) {
    result.name = "laravel";
    result.label = "Laravel (PHP)";
    result.languages.push("php");
    result.commands.test = exists(root, "vendor/bin/pest") ? "./vendor/bin/pest" : "php artisan test";
    if (exists(root, "vendor/bin/pint")) result.commands.lint = "./vendor/bin/pint --test";
    if (exists(root, "vendor/bin/phpstan")) result.commands.typecheck = "./vendor/bin/phpstan analyse --no-progress";
    result.commands.routes = "php artisan route:list --json";
    result.notes.push(
      "Laravel conventions: controllers in app/Http/Controllers, models in app/Models, migrations in database/migrations, routes in routes/*.php, tests in tests/Feature and tests/Unit.",
      "Create files with artisan where sensible (php artisan make:model/controller/migration/request/test) — these commands are allowed.",
    );
  } else if (composer) {
    result.name = "php";
    result.label = "PHP (Composer)";
    result.languages.push("php");
    if (exists(root, "vendor/bin/phpunit")) result.commands.test = "./vendor/bin/phpunit";
    if (exists(root, "vendor/bin/phpstan")) result.commands.typecheck = "./vendor/bin/phpstan analyse --no-progress";
  }

  // ---- Node ------------------------------------------------------------
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const scripts = pkg.scripts ?? {};
    const has = (d) => d in deps;
    const pm = exists(root, "pnpm-lock.yaml") ? "pnpm" : exists(root, "yarn.lock") ? "yarn" : exists(root, "bun.lockb") ? "bun" : "npm";
    const runScript = (s) => (pm === "npm" ? `npm run ${s}` : `${pm} run ${s}`);

    const isTs = exists(root, "tsconfig.json") || has("typescript");
    result.languages.push(isTs ? "typescript" : "javascript");

    let nodeLabel = "Node.js";
    if (has("next")) nodeLabel = "Next.js";
    else if (has("nuxt")) nodeLabel = "Nuxt";
    else if (has("@nestjs/core")) nodeLabel = "NestJS";
    else if (has("express")) nodeLabel = "Express";
    else if (has("fastify")) nodeLabel = "Fastify";
    else if (has("vue")) nodeLabel = "Vue";
    else if (has("react")) nodeLabel = "React";
    else if (has("@angular/core")) nodeLabel = "Angular";

    if (result.name === "generic") {
      result.name = "node";
      result.label = `${nodeLabel} (${isTs ? "TypeScript" : "JavaScript"})`;
    } else {
      result.label += ` + ${nodeLabel} frontend`;
    }

    if (scripts.test && !/no test specified/.test(scripts.test)) result.commands.test ??= runScript("test");
    if (scripts.lint) result.commands.lint ??= runScript("lint");
    if (scripts.build) result.commands.build = runScript("build");
    if (isTs) result.commands.typecheck ??= `npx tsc --noEmit${exists(root, "tsconfig.json") ? "" : " -p ."}`;
    result.notes.push(`Package manager: ${pm}. Do not switch package managers.`);
  }

  // ---- Python ----------------------------------------------------------
  if (exists(root, "manage.py")) {
    result.name = result.name === "generic" ? "django" : result.name;
    result.label = result.name === "django" ? "Django (Python)" : result.label;
    result.languages.push("python");
    result.commands.test ??= "python manage.py test";
  } else if (exists(root, "pyproject.toml") || exists(root, "requirements.txt")) {
    if (result.name === "generic") {
      result.name = "python";
      result.label = "Python";
    }
    result.languages.push("python");
    result.commands.test ??= "python -m pytest -q";
  }

  // ---- Ruby / Go / Rust ------------------------------------------------
  if (exists(root, "Gemfile") && exists(root, "config/application.rb")) {
    result.name = "rails";
    result.label = "Ruby on Rails";
    result.languages.push("ruby");
    result.commands.test ??= "bin/rails test";
  }
  if (exists(root, "go.mod")) {
    if (result.name === "generic") (result.name = "go"), (result.label = "Go");
    result.languages.push("go");
    result.commands.test ??= "go test ./...";
    result.commands.build ??= "go build ./...";
    result.commands.lint ??= "go vet ./...";
  }
  if (exists(root, "Cargo.toml")) {
    if (result.name === "generic") (result.name = "rust"), (result.label = "Rust");
    result.languages.push("rust");
    result.commands.test ??= "cargo test";
    result.commands.build ??= "cargo build";
  }

  result.languages = [...new Set(result.languages)];
  return result;
}

/**
 * Build the full allow-list of shell commands the agent may run.
 * A command is allowed if it starts with one of these prefixes.
 */
export function allowedCommandPrefixes(framework, config) {
  const base = [
    ...Object.values(framework.commands),
    ...(config.allowedCommands ?? []),
    "git status", "git diff", "git log", "git add", "git commit",
  ];
  if (framework.name === "laravel") {
    base.push(
      "php artisan make:", "php artisan migrate", "php artisan route:list", "php artisan tinker --execute",
      "php artisan test", "php artisan config:clear", "php artisan cache:clear", "php artisan optimize:clear",
      "php -l", "composer dump-autoload", "composer require", "composer install", "./vendor/bin/",
    );
  }
  if (framework.languages.includes("javascript") || framework.languages.includes("typescript")) {
    base.push("npm test", "npm run", "npm install", "npx tsc", "npx eslint", "npx prettier", "npx vitest", "npx jest",
      "pnpm test", "pnpm run", "pnpm install", "yarn test", "yarn run", "yarn add", "node --check", "node ");
  }
  if (framework.languages.includes("python")) base.push("python -m pytest", "python manage.py", "python -m py_compile", "ruff ", "pip install");
  if (framework.languages.includes("go")) base.push("go ");
  if (framework.languages.includes("rust")) base.push("cargo ");
  return [...new Set(base.filter(Boolean))];
}
