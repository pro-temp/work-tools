# Global Engineering Guidelines

## Scope and communication

- Precedence: explicit user instructions > repo/project instructions and matching skills > these defaults. Local conventions, required checks, correctness, security, accessibility, compatibility, resource cleanup, required error handling, and API contracts always override style preferences; explain material exceptions.
- Scope: communication and task completion apply everywhere; engineering rules apply to code; frontend rules apply to UI, components, hooks/composables, state, requests, routing, and interactions (not backend-only JS/TS).
- Default to ELI5; go deeper if asked. Lead with the answer, finding, or action using concrete facts/examples. Cut filler openings, canned transitions, invented labels, unsolicited contrasts, and repetitive endings. Keep final answers self-contained.

## Task completion

- Match the deliverable: carry action requests through implementation and verification; for reviews, explanations, or plans alone, deliver only what was asked.
- Resolve ambiguity from evidence; make reversible in-scope decisions, continue, and state behavior-affecting assumptions.
- Use existing authorization. Confirm only user-only decisions, out-of-scope actions, or outstanding approvals (including destructive/irreversible steps)—not hypothetical risks. Finish independent work first and show a concrete draft, diff, or choice.
- If a skill or instruction rule makes you pause, seek confirmation, change course, or stop early, link the file, quote the clause, explain how it applies, and note any part that was your judgment.
- On long tasks, keep working past progress updates while authorized work remains. After interruptions, check what finished and resume. On failure, try another in-scope approach; if blocked externally, state what remains, the blocker, and what unblocks it.

## Engineering and defensive code

- **Change discipline**: inspect entry points, callers, contracts, and nearby code first. Make the smallest correct change optimized for reading, debugging, and modifying; remove dead code you introduce and leave unrelated code untouched.
- **Evidence-backed guards**: fix edge cases backed by evidence (code path, user flow, API contract, or reproduction) at the responsible layer, even if rare; report out-of-scope gaps. Omit speculative hardening unless authorized (propose it with failure scenario, likelihood, and complexity cost).
- **Trust contracts**: validate unknown inputs once at the owning boundary, then trust established types, schemas, request wrappers, props, and callers instead of re-checking (`?.`, `?? []`, `typeof`, `Array.isArray`). Example: if the wrapper rejects on failure and guarantees `rows`, write `page.rows.map(toOption)`, not `(page?.rows ?? []).map(toOption)`.
- **Permitted absence**: use defaults only for contract-permitted absence with business meaning, never to hide contract/type/API errors. Use the shortest idiomatic form valid for all contract inputs (e.g., `data?.code || ''` when `data` is `null` on no match and `code` is a string on match). Match local style without copying unjustified guards, and leave untouched guards alone.
- **Self-check & reviews**: before finishing, verify every added guard, fallback, state, or branch against a contract or reachable failure and drop any without basis; explain only behavior-affecting choices. Back missing-check findings with a reachable input/sequence and wrong behavior; flag unjustified guards as simplifications.

## Code style

- Keep simple logic inline; extract helpers only for reuse, composition, a complex boundary, or a clear independent concept, not single-use wrappers.
- Avoid unnecessary `try`/`catch`; keep catches for recovery, cleanup, error reporting, and network/input/lifecycle boundaries; never swallow errors.
- Avoid `any` (`unknown`, narrowing, generics, or narrow documented exceptions for external APIs); rely on type inference unless exports, contracts, or clarity need annotations.
- Use `import type` instead of inline `import("...")`; avoid default import aliases and `import *` unless a third-party API requires them; keep dynamic imports of heavy optional modules inside their branch. Comment only non-obvious constraints or surprising behavior.

## Frontend rules

- **Architecture & reuse**: preserve framework, directory boundaries, and public contracts. Reuse existing request, error-handling, and UI capabilities; do not add deps, configs, compat branches, or abstractions for hypothetical needs. Prefer shallow structure and a single source of truth; shared/cross-module utilities need real consumers, consistent semantics, clear ownership, and stable contracts. Justify complexity by real requirements (target browsers, concurrency, perf, a11y, security); never strip needed safeguards or cleanup.
- **Concurrency & FE/BE boundary**: locks, sequence numbers, queues, Promise caches, retries, and guard state require evidence and a reason existing mechanisms fall short; use one simple mechanism without layering duplicates. Backends own final idempotency, auth, and consistency; frontends own feedback, basic validation, and UI state. Do not assume unconfirmed backend guarantees (report the gap instead of heavy UI workarounds), while trusting guaranteed API response shapes so violations surface as errors.
- **Values & errors**: show real empty states rather than adding redundant empty arrays/objects/placeholders when downstream handles absence. Distinguish absence, `''`, `0`, and `false` by business semantics—never overwrite valid values with `||` or mechanically swap to `??`; follow project null helpers and browser targets. Keep reachable failures recoverable via existing error mechanisms.

## Verification and delivery

- Run the smallest credible checks for the change (reproduce/verify fixes, cover main path and boundaries for features, confirm parity for refactors via diff review, targeted lint, typecheck, existing tests, or runtime checks). Broaden to full builds/suites when build outputs, routing/bootstrap, package boundaries, or cross-module behavior change, obeying repo check gates. Skip repeating passed checks without new changes, failures, or unresolved risks. Report changes, actual checks run, and unverified gaps affecting conclusions.
- **Frontend unit tests**: never add frontend unit tests by default or proactively add a test setup/framework/dep/config. With an existing usable setup, follow conventions and add only necessary change-specific tests. When a change needs new tests (state transitions, async flows, permissions, data mapping, shared contracts, recurring defects) without a usable setup, explain why and agree on scope first (prior approval covers it).

<!-- Source attribution & upstream MIT license: ./ATTRIBUTION.md -->
