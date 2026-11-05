# codemender-ai

An autonomous AI maintainer you drop into any project. Install it, point it at Claude (or any other model), and it will:

- **Finish incomplete work** — finds `TODO` / `FIXME` / `HACK` comments and "not implemented" stubs and implements them.
- **Fix broken code** — runs your lint, type-check and test commands; anything that fails becomes a task the agent fixes at the root cause.
- **Implement module-wise requirements** — you write `requirements/<module>.md` with checklists; it implements each unchecked item (models, migrations, routes, controllers, tests…) and ticks the box when done.
- **Never stop on a token limit** — when Claude runs out of credit, hits a rate limit, or exceeds a token budget you set, it automatically switches to a free model (OpenRouter free tier, Groq, or a local Ollama model) and keeps going.

Works with **Laravel**, **Node** (Express, NestJS, Next.js, Vue, React…), Django, Rails, Go, Rust and plain projects. Framework detection picks the right verification commands automatically.

## Install

```bash
npm install --save-dev codemender-ai      # inside your project
# or
npx codemender-ai --help                  # no install
```

Requires Node 20+. For Laravel projects Node is only needed to run the agent; your app stays pure PHP.

## Quick start

```bash
export ANTHROPIC_API_KEY=sk-ant-...        # primary model (Claude)
export OPENROUTER_API_KEY=sk-or-...        # optional: free fallback models
# (or run `ollama pull qwen2.5-coder:7b` for a fully offline fallback)

npx codemender init      # writes codemender.config.json + requirements/ + framework hooks
npx codemender doctor    # checks keys, providers and detected commands
npx codemender scan      # shows what it would do
npx codemender run       # does it
```

## Commands

| Command | What it does |
|---|---|
| `codemender init` | Create config, `requirements/` folder, Laravel artisan command |
| `codemender scan` | List pending requirements, failing checks, TODOs/stubs |
| `codemender run` | Complete everything: requirements → failing checks → TODOs |
| `codemender fix` | Only fix failing lint / type-check / tests |
| `codemender todos` | Only finish TODO / FIXME / stubs |
| `codemender requirements` | Only implement pending requirement items |
| `codemender watch` | Keep running whenever files or requirements change |
| `codemender doctor` | Verify each configured provider is reachable |

Useful flags: `--dry-run`, `--limit 3`, `--commit` (git-commit after each task), `--provider ollama --model qwen2.5-coder:7b`, `--effort xhigh`, `--verbose`.

## Writing requirements

One markdown file per module in `requirements/`. Every unchecked checkbox is a task. Indented lines beneath an item are passed to the agent as details. The whole file is given as context so the agent understands the module.

```markdown
# Orders

## Data
- [ ] `orders` table: id, user_id (FK), status (enum: pending|paid|shipped), total (decimal), timestamps
- [ ] Order model with `user()` relation and `scopePaid()`

## API
- [ ] POST /api/orders — create an order for the authenticated user
    Validate: items[] required, each with product_id and qty >= 1
    Return 201 with the order resource
- [x] GET /api/orders — already done
```

After each item is implemented and verified, Codemender flips `[ ]` to `[x]` in the file. A file with no checkboxes is treated as one task and gets a `<!-- codemender:done -->` marker when complete.

## Choosing and switching models

`codemender.config.json`:

```json
{
  "provider": "anthropic",
  "model": "claude-opus-5-5",
  "effort": "high",
  "fallbacks": [
    { "provider": "openrouter", "model": "meta-llama/llama-3.3-70b-instruct:free" },
    { "provider": "ollama", "model": "qwen2.5-coder:7b" }
  ],
  "budget": { "maxTokensPerRun": 2000000 }
}
```

Providers: `anthropic` (official SDK), `openai`, `openrouter`, `groq`, `deepseek`, `ollama`, or `custom` (any OpenAI-compatible endpoint via `baseURL`). Keys come from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `CODEMENDER_CUSTOM_API_KEY`; Ollama needs none.

The chain switches to the next fallback when the current provider returns a rate limit (429), out-of-credit / billing error (402 or "credit balance is too low"), overload (529), an authentication error, repeated network failures, or when the run's token usage passes `budget.maxTokensPerRun`. Once switched it stays on the fallback for the rest of the run so a flapping provider doesn't waste tokens. Every switch is logged and recorded in `.codemender/state.json`.

Anthropic models also get the server-side refusal fallback (`fallbacks: "default"`) so a safety decline is re-run on another Claude model inside the same request. Set `"anthropic": { "serverFallback": false }` to turn that off.

## Laravel integration

`codemender init` inside a Laravel app installs `app/Console/Commands/CodemenderCommand.php`:

```bash
php artisan codemender:run              # same as npx codemender run
php artisan codemender:run scan
php artisan codemender:run fix --limit=3 --commit
```

Schedule it in `routes/console.php`:

```php
Schedule::command('codemender:run')->hourly()->withoutOverlapping();
```

In Laravel projects the agent may run `php artisan make:*`, `php artisan migrate`, `php artisan test`, Pest, Pint, PHPStan and Composer. Add anything else to `allowedCommands`.

## Node / programmatic use

```js
import { createAgent } from "codemender-ai";

const agent = createAgent({ root: process.cwd(), config: { model: "claude-opus-5-5" } });

await agent.run();                          // everything
await agent.fix();                          // failing checks only
await agent.implementRequirements();        // requirements only
agent.watch();                              // keep running on file changes
const stop = agent.schedule(30 * 60_000);   // every 30 min inside a server
```

Lower-level pieces are exported too: `scan`, `runTask`, `detectFramework`, `createProviderChain`, `scanRequirements`, `markRequirementDone`.

You can also pass your own provider object as a fallback: anything with `{ id, provider, model, chat({system, messages, tools}) }` that returns `{ content, stopReason, usage }` in Anthropic content-block format.

## Safety rails

- File tools are confined to the project root (symlinks resolved); `.git` is never touched directly.
- `run_command` only accepts an allow-list: detected test/lint/build commands, framework scaffolding (`php artisan make:*`, `npm run …`), git, plus your `allowedCommands`. Shell operators (`; | & > $`) are rejected.
- Tasks that fail three times are skipped in later runs (see `.codemender/state.json`).
- `git.requireCleanTree: true` refuses to run on a dirty tree; `--commit` makes one commit per completed task so everything is reviewable and revertible.
- The agent is told never to delete or weaken tests to make them pass.

Run it on a branch and review the diff. It's a tireless junior engineer, not a substitute for code review.

## Configuration reference

| Key | Default | Meaning |
|---|---|---|
| `provider`, `model`, `effort` | `anthropic`, `claude-opus-5-5`, `high` | Primary model |
| `fallbacks[]` | OpenRouter free → Ollama | Tried in order when the primary is exhausted |
| `budget.maxTokensPerRun` | `0` (unlimited) | Switch to fallbacks after this many tokens on the primary |
| `requirementsDir` | `requirements` | Where module requirement files live |
| `tasks.todos/issues/requirements` | `true` | Which task sources to scan |
| `include` / `exclude` | sensible defaults | Globs for files the agent may see |
| `allowedCommands[]` | `[]` | Extra command prefixes the agent may run |
| `maxIterations` | `60` | Tool-call rounds per task |
| `maxTasksPerRun` | `20` | Tasks per run (rest deferred) |
| `commandTimeoutMs` | `300000` | Timeout for verification commands |
| `git.autoCommit` / `git.requireCleanTree` | `false` / `false` | Git behaviour |
| `watch.debounceMs` | `2000` | Watch-mode debounce |

Environment overrides: `CODEMENDER_PROVIDER`, `CODEMENDER_MODEL`, `CODEMENDER_EFFORT`, `CODEMENDER_REQUIREMENTS_DIR`, `CODEMENDER_MAX_TOKENS_PER_RUN`, `CODEMENDER_LOG_LEVEL`.

## License

MIT
