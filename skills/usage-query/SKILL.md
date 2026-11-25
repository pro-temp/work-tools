---
name: usage-query
description: Query local coding-agent token usage from natural-language Chinese requests by running the ccusage CLI. Use for requests such as “查看今天 kimi 用量”, “查看今天 grok 用量”, “查看 codex 昨天的 token 用量”, date ranges, multiple agents, or all-agent usage.
---

# Usage Query

## Overview

Translate a natural-language usage request into one or more `ccusage` commands, execute them locally, and return the actual report table. Never return only a suggested command when the user asked to查看/统计用量.

## Workflow

1. Identify the agent name and time range from the request.
2. Run the matching command with `--timezone Asia/Shanghai` and `--no-cost` unless the user explicitly asks for cost.
3. Present the command result directly, preserving the table and stating the queried range.

## Agent Mapping

Map agent words to subcommands: `kimi` -> `ccusage kimi daily`; `codex` -> `ccusage codex daily`; `claude` -> `ccusage claude daily`; `gemini` -> `ccusage gemini daily`; `grok` -> `ccusage grok daily`. For another supported agent, use the corresponding `ccusage <agent> daily` command. “全部”, “所有”, or no agent means `ccusage daily`.

Grok Build CLI needs `ccusage` >= 20.0.20. If the global binary is older, or `ccusage grok` returns `Unknown command`, rerun with `npx --yes ccusage@latest` and the same flags. Before concluding any agent is unsupported, check `npm view ccusage version` and retry `@latest`; do not treat a stale global `--help` list as the source of truth.

If multiple agents are named, run each agent command separately and add a concise combined total when the output provides compatible token columns. Do not invent a multi-agent ccusage flag.

## Date Mapping

Use actual calendar dates in `YYYY-MM-DD`:

- “今天” -> `--since <today>`
- “昨天” -> `--since <yesterday> --until <yesterday>`
- “昨天和今天”, “这两天” -> `--since <yesterday> --until <today>`
- “近 N 天” -> `--since <N days before today>` (include today)
- “本周” -> `--since <Monday of current week>`
- “本月” -> `--since <first day of current month>`
- An explicit date or date range -> use the stated dates; include `--until` for an end date.

For every command append `--timezone Asia/Shanghai --no-cost`. Remove `--no-cost` only when the user asks about cost, price, or spending. Use `--json` only when the user requests machine-readable output.

## Examples

- “查看今天 kimi 用量” -> `ccusage kimi daily --since <today> --timezone Asia/Shanghai --no-cost`
- “查看今天 grok 用量” -> `ccusage grok daily --since <today> --timezone Asia/Shanghai --no-cost`
- “查看 codex 昨天和今天的 token 用量” -> `ccusage codex daily --since <yesterday> --until <today> --timezone Asia/Shanghai --no-cost`
- “查看全部本月用量” -> `ccusage daily --since <first-of-month> --timezone Asia/Shanghai --no-cost`

If `ccusage` is unavailable, report that it is not installed and provide the install command `npm install -g ccusage`; do not silently substitute estimates or another tool.
