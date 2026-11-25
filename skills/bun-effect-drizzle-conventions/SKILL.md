---
name: bun-effect-drizzle-conventions
description: Coding conventions for TypeScript projects that already use Bun, Effect, Drizzle ORM, or the src/config self-export pattern. Use only when the repository already uses one or more of those technologies; do not use for Node.js, Vue, React, or other stacks, and never migrate a project onto them.
---

# Bun, Effect, Drizzle, and `src/config` Conventions

Apply each subsection below **only** when the target project already uses that runtime, library, or module convention. Never introduce Bun, Effect, Drizzle, or self-export configs into projects that do not use them, and preserve established local conventions, public contracts, and runtime compatibility.

## Bun

- In projects already running on Bun, prefer suitable Bun APIs such as `Bun.file()`.
- Preserve the project's actual runtime and compatibility requirements.

## Effect

- In existing Effect generators, bind services to named variables before calling methods; avoid nested service yields such as `yield* (yield* Foo.Service).bar()`.
- Preserve named Effect service bindings even when otherwise inlining single-use variables.
- Return `Effect` from a helper only when it performs effectful work; keep synchronous parsing, validation, and option building synchronous.
- When using Effect to parse untrusted JSON strings, prefer available schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try`.

## Drizzle ORM

- In Drizzle projects whose schema conventions support it, use `snake_case` field keys (such as `project_id` and `created_at`) so inferred column names do not need redundant string definitions.
- Preserve established schema mappings and public contracts; do not rename existing fields.

## `src/config` Self-Export Pattern

- When adding a module to a `src/config` directory that already uses a self-export pattern, follow it at the top of the file (for example, `export * as ConfigAgent from "./agent.js"`).
- Do not introduce this architecture solely because a directory is named `src/config`.

## Source

Adapted from [anomalyco/opencode AGENTS.md](https://github.com/anomalyco/opencode/blob/b79dce4ce30954a437344beaa9fa7fe4b965f28b/AGENTS.md#style-guide) (MIT License, see [LICENSE](./LICENSE)).
