# dsh-zcode-project-memory

English | [中文](README.md)

Project-scoped long-term memory for the DeepSeek Harness. Lessons a model distills during one session are read back automatically in later sessions.

One Cordis plugin that does three things:

1. **Registers the `save_project_memory` tool** — writes a memory (its own file, plus an index update).
2. **Injects memory guidance into the system prompt** (`ctx.systemPrompt.section()`) — tells the model when to write, in what format, and how to delete.
3. **Injects the memory index into the runtime context** (`ctx.systemPrompt.context()`) — every new session opens with a catalog of existing memories.

Memory is isolated **per project**: the directory name is derived from the sha256 of the project root's canonical absolute path. The same project hits the same memory from any process and any session; different projects cannot see each other's.

The mechanism is a port of [zai-org/ZCode](https://github.com/zai-org/ZCode), and DSH-side interfaces follow the [official DeepSeek Harness documentation](https://deepseek-harness.github.io/deepseek-harness/).

> **Unofficial project.** This is a community work. It is not affiliated with, authorized, sponsored, or endorsed by Z.AI Co., Ltd (the developers of ZCode) or by DeepSeek. The `zcode` in the package name describes the origin of the implementation only (see above and [`NOTICE.md`](NOTICE.md)). "ZCode" is a trademark of its respective owner, and this project uses the name solely to describe that origin.

## Install

```sh
dsh plugin --profile <your-profile> add /path/to/dsh-zcode-project-memory
```

`package.json` declares `dsh.bundle.patch`, so `dsh plugin add` adds it to the profile's bundle layer automatically.

The plugin injects the `tools` and `systemPrompt` host services, both provided by `dsh-base`. Any profile inheriting `dsh-base` (web / headless / tui) activates it; a deployment missing either service leaves the plugin PENDING with no side effects.

## Usage

Once installed, there is nothing to configure — the plugin is one model-facing tool plus two automatic injections. **Normal conversation is the whole interface.** No commands to remember, no files to tidy by hand.

### Teach it something

Just say so, or let the model decide on its own:

```
Remember: migrations in this project must run in staging for 24 hours before production.
```

The model calls `save_project_memory`, which writes a memory plus an index update. It is also told to save proactively when it hits **non-obvious project conventions, architectural decisions, or gotchas found while debugging** — knowledge a future reader could not cheaply derive from the repository.

What it will not save: transient task state, and facts the repository already records (code structure, git history, the contents of AGENTS.md). The guidance excludes both.

### Ask it to recall

Just ask in a new session — **the memory index is already in context from the first turn**:

```
What is in this project's long-term memory?
What was that migration constraint we discussed?
```

The model sees the index lines and reads the relevant memory files for detail. This works across sessions and across processes: memory lives on disk, not in a session that has to still be alive.

### Ask it to forget

There is no delete tool, so just say:

```
Forget the memory about migrations.
```

The model deletes the memory file **and** removes its line from `MEMORY.md`. You can also delete by hand (see "Deleting a memory" below).

### Inspect what it knows

Memory is plain Markdown, readable and editable at any time:

```sh
M=~/.dsh/memories/projects/<project-basename>-<hash>/memory
cat "$M/MEMORY.md"     # the index: one line per memory
ls "$M"                # one .md file per memory
```

To wipe a project's memory, delete the whole `memory/` directory — the plugin degrades quietly on a missing directory.

## Commands

This package is **plain JavaScript (ESM)** with no transpile or build step — the sources under `src/` *are* the published artifact, so there are only install and test commands:

| Command | Description |
|---|---|
| `npm install` | Install the only runtime dependency, `@deepseek-ai/schemastery` |
| `npm test` | Full test suite (129 checks) |
| `npm run test:subsystems` | Only the three subsystems' minimal executable cases |

Reproducing from scratch:

```sh
git clone https://github.com/ffyfox/dsh-zcode-project-memory.git && cd dsh-zcode-project-memory
npm ci        # or npm install
npm test      # exit code 0 means it passed
```

Requires Node.js `>=20` (see `engines` in `package.json`). CI runs the same command on Node 20 and 22 — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Where memory lives

```
<DSH_HOME>/memories/projects/<project-basename>-<hash16>/memory/
├── MEMORY.md          # index: one line per memory, never body text
└── <slug>.md          # one file per memory, with frontmatter
```

`DSH_HOME` defaults to `~/.dsh`. Memory is **never written into the project repository**, so the project directory stays clean and is unaffected by git operations, cleanup, or read-only mounts.

## Memory file shape

```markdown
---
name: "auth-token-refresh-gotcha"
description: "Expired tokens return 401, not 403."
metadata:
  type: project
  node_type: memory
  originSessionId: "session-…"
---

The refresh endpoint returns 401 (not 403) when the token is merely expired.

**Why:** retry logic keyed on 403 silently drops expired-token retries.
```

`MEMORY.md` holds pointers only, one line each:

```markdown
- [Auth token refresh gotcha](auth-token-refresh-gotcha.md) — Expired tokens return 401, not 403.
```

`type` is one of four values: `user` (who the user is), `feedback` (guidance on how to work), `project` (ongoing work and constraints), `reference` (pointers to external resources). Saving the same memory twice replaces its file and index line rather than stacking duplicates.

The index is truncated past 200 lines or 25,000 characters, and the injection says so.

### Where filenames come from

The filename is sanitized from `key`:

| `key` | Filename |
|---|---|
| `Auth token refresh gotcha` | `auth-token-refresh-gotcha.md` |
| `部署规则` | `memory-9c31a6.md` |

The character class is `[a-z0-9._-]`. **Non-ASCII characters are dropped entirely**, so when a `key` contains anything outside that class, a 6-hex hash of the original key is appended — otherwise `部署规则` / `发布前检查` / `你的哨兵` would all collapse to the same `memory.md` and overwrite each other. Purely ASCII keys are unaffected, and existing memories are never renamed.

### Deleting a memory

**There is no delete tool.** Deletion is two halves: remove the memory's file, **and** remove its line from `MEMORY.md` — deleting only the file leaves a dangling index pointer. The injected guidance tells the model exactly this, triggered when "the user asks you to forget something" or "a memory turns out to be wrong or outdated".

By hand, the same two halves:

```sh
M=~/.dsh/memories/projects/<project>-<hash>/memory
rm -f "$M/<slug>.md"
# then remove the matching line from $M/MEMORY.md
```

## Architecture

```
src/index.js            Cordis plugin entry: tool registration + two injections
├── src/store.js        Memory IO: path derivation, atomic write, stable read, locking
├── src/memory-format.js Rendering/parsing of memories and the index, slug sanitizing
├── src/prompt.js       Text rendering for the two injection surfaces
└── src/subsystems/     Three optional subsystems, importable individually (below)
```

### The two injection surfaces

| Content | Injection API | Position |
|---|---|---|
| Memory **guidance** (when to write, format, how to delete) | `ctx.systemPrompt.section()` | system prompt |
| Memory **index** (the `MEMORY.md` text) | `ctx.systemPrompt.context()` | user-role runtime snapshot |

Splitting these in two matches ZCode: guidance is a stable rule, the index is data that changes with content.

### Subsystems

The three modules under `src/subsystems/` are ported from ZCode's `core/src/memory/`. They **do not import each other** and can be imported and called individually; where one needs another, it goes through parameter injection (a `formatManifest` / `execute` callback) rather than an import.

They are **not** started automatically by `apply()` — the plugin's runtime behavior is exactly the three things above.

| Subsystem | Entry points | Output |
|---|---|---|
| manifest scan | `scanMemoryManifest({fileSystem?, rootDir, signal?})`, `formatMemoryManifest(manifest)` | Memory file catalog (entry array / one-line-per-entry text) |
| auto-extraction | `createMemoryExtractionScheduler(execute)`, `evaluateMemoryExtraction(snapshot, cursor)`, `buildMemoryExtractionPrompt(…)` | Extraction decision + incremental range + extraction prompt |
| background summarization | `runMemoryAgentLoop({model, tools, executeTool, …})`, `evaluateMemoryAgentToolPolicy(input)` | Summary text + turn count + tool-call trace |

```js
import { scanMemoryManifest, formatMemoryManifest } from 'dsh-zcode-project-memory/src/subsystems/manifest.js'

const manifest = await scanMemoryManifest({ rootDir: memoryRoot })
console.log(formatMemoryManifest(manifest))
// - [project] auth-token-refresh-gotcha.md (2026-09-22T05:05:00.000Z): Expired tokens return 401…
```

The `files` whitelist includes all of `src`, so `src/subsystems/` ships with the package. Each subsystem has its own minimal executable case that prints one parseable JSON line to stdout (`{"subsystem": "manifest", …}`) and exits 0.

## Configuration

The plugin exports a Schemastery `Config`. All three fields directly affect injection volume or per-memory capacity — values two deployments might reasonably set differently:

```yaml
- id: project-memory
  config:
    indexLineLimit: 200        # max index lines injected
    indexCharacterLimit: 25000 # max index characters injected
    maxMemoryChars: 8000       # max body length of a single memory
```

Defaults match the built-in constants, so behavior is unchanged when unconfigured. Invalid values (such as `maxMemoryChars: 0`) fail at plugin load rather than degrading silently.

## Failure behavior

Memory is an enhancement and must never become a source of session failure:

- Memory missing or unreadable → inject an empty string, leaving no empty placeholder in context.
- No resolvable project directory → the tool returns `saved: false` and both injections return an empty string.
- Reads always reject symlinks and non-regular files, with a 5 MiB size cap.

On the write side: symlink write-through is refused, existing permission bits are preserved, the temp file is created exclusively with `O_EXCL|O_NOFOLLOW`, and `fsync` precedes `rename`. The index read-modify-write is serialized with an in-process queue plus a cross-process file lock, so concurrent saves do not lose entries.

## Tests

```sh
npm test
```

| Test | Covers |
|---|---|
| `test/injection.mjs` | Injection surfaces are section + context; tool parameters and output use the real contract |
| `test/config.mjs` | Config export, Standard Schema interface, defaults on the schema, load-time failure on invalid config |
| `test/roundtrip.mjs` | Write → read back in a **separate process**, byte-identical; file shape; duplicate-save replacement; project isolation |
| `test/isolation.mjs` | Path spelling normalization; same basename under different parents does not collide; writing A does not affect B |
| `test/robustness.mjs` | Symlink refusal, permission preservation, atomic replacement, stable read, path safety, size cap, no entry loss under concurrency, `exec.signal` propagation, raw-tool self-validation |
| `test/subsystem-manifest.mjs` | Recursive collection, skipping the index / non-`.md` / broken symlinks, mtime-descending order, field set, render format, injectable port |
| `test/subsystem-extraction.mjs` | Cursor semantics, both skip rules and their precedence, prompt elements, scheduler coalescing / no cursor advance on error / shutdown |
| `test/subsystem-summarization.mjs` | Denial messages, tool whitelist, network/Agent/mcp refusal, write-delete boundary inside the memory dir, turn budget and parallel tool calls |
| `test/packaging.mjs` | Package contents as expected, source reads no repo `.md` file, entry closure free of dev-only files |

End-to-end manual verification (requires working model credentials):

```sh
cd /your/project
dsh --profile headless "Save this lesson to project memory: <...>, then reply DONE"
dsh --profile headless "What is in this project's long-term memory? Quote the index lines verbatim."
```

## Differences from ZCode

The port targets behavioral equivalence; the following differences are deliberate:

| Difference | Notes |
|---|---|
| Save entry point | ZCode has no memory tool and the model writes files with `write` directly; this plugin provides `save_project_memory`, and the guidance points at that tool instead |
| Index maintenance | ZCode has the model update `MEMORY.md` by hand; this plugin updates it in code at save time, so the two cannot disagree |
| Index concurrency | ZCode uses `expectedRevision` optimistic concurrency and fails on conflict; this plugin queues plus takes a file lock, so one save does not fail because someone else is saving a different memory |
| `# agentsMd` heading | ZCode wraps the index and the AGENTS.md instructions under one heading; on DSH those instructions are owned by `dsh-agent-instructions`, so this plugin does not emit that heading |
| HTML comment stripping | No `marked` dependency; a fence-aware conservative approximation instead (keep too much rather than delete body text) |
| Section order values | The official `getSectionOrder()` accepts only names registered in-repo, which an out-of-repo plugin cannot obtain, so values are chosen locally (section 950 / context 100) |
| Tool naming | Subsystem tool whitelists use the lowercase names DSH actually registers (`read`/`write`/`edit`/`bash`); ZCode's capitalized names never match on DSH |

### Not ported

| Item | Reason |
|---|---|
| Automatic **triggering** of per-turn extraction + background summarization | The subsystems are implemented and usable, but are not mounted by default. Unconditional per-turn triggering compounds token cost, adds concurrency-limit pressure, and grows memory entropy |
| Frontmatter repair of existing files | `node_type` / `originSessionId` are written only when a memory is created; existing files are never rewritten |

The conformance report is at [`docs/conformance-report.md`](docs/conformance-report.md).

## Contributing

Development environment, testing, and commit conventions are in [`CONTRIBUTING.md`](CONTRIBUTING.md); participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Release history is in [`CHANGELOG.md`](CHANGELOG.md).

## License

This project's own code is MIT. Parts of the implementation are ported from [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0, Copyright 2026 Z.AI Co., Ltd), so the whole is **MIT AND Apache-2.0**.

Per-file port mapping is in [`NOTICE.md`](NOTICE.md); the full Apache-2.0 text is in [`LICENSE-APACHE-2.0`](LICENSE-APACHE-2.0), and the upstream NOTICE is in [`NOTICE-ZCode.md`](NOTICE-ZCode.md).
