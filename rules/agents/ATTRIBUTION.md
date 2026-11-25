# Source Attribution and Upstream License

This file holds source attribution and license text moved out of [AGENTS.md](./AGENTS.md) so the global instructions loaded into every agent session stay concise.

## Maintained Sources

- Global instructions single source: `~/.agents/AGENTS.md`
  - Codex: `~/.codex/AGENTS.md` (symlink)
  - Gemini / Antigravity: `~/.gemini/config/GEMINI.md` (symlink)
  - Claude Code: `~/.claude/CLAUDE.md` (`@../.agents/AGENTS.md`)
- Extracted stack-specific skill: `~/.agents/skills/bun-effect-drizzle-conventions/SKILL.md` (Bun, Effect, Drizzle, and `src/config` self-export conventions)

## Upstream Sources

- The communication and task completion guidance draws on the writing, initiative, and instruction-following sections of [OpenAI's GPT-6 Astra guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#prompting-best-practices), consulted on 2026-11-18.
- The code style rules (and the Bun, Effect, Drizzle, and `src/config` conventions now extracted to `bun-effect-drizzle-conventions`) adapt only General Principles, Destructuring, Imports, Variables, Control Flow, Complex Logic, and Schema Definitions (Drizzle) from [anomalyco/opencode AGENTS.md, commit b79dce4ce30954a437344beaa9fa7fe4b965f28b](https://github.com/anomalyco/opencode/blob/b79dce4ce30954a437344beaa9fa7fe4b965f28b/AGENTS.md#style-guide), retrieved on 2026-10-25. Repository-specific commands, branching, commits, testing, and other sections were not imported.
- The original frontend-guidelines rules were translated and consolidated into `AGENTS.md`, with cross-cutting defensive rules merged under Defensive code.

## Upstream MIT License

Upstream [MIT license at the same commit](https://github.com/anomalyco/opencode/blob/b79dce4ce30954a437344beaa9fa7fe4b965f28b/LICENSE):

```text
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
