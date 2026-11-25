---
name: instruction-audit
description: Review or revise persistent instructions in files such as AGENTS.md, CLAUDE.md, and SKILL.md. Identify rules that can lead an agent to take the wrong action, ask for approval repeatedly, stop early, or produce formulaic writing.
---

# Reviewing persistent instructions

## Evidence and scope

- Start with the file or directory the user named. Follow inheritance, imports, links, and trigger conditions to find the relevant rules. When several tools share instructions, locate the maintained source and check what each tool actually loads. Assess conflicts among rules that apply to the same scenario.
- Use the wording, project facts, and the user's authorization to determine how a rule affects a task. Consult model-specific documentation or observed behavior only when a finding depends on that model. If the model or source cannot be verified, qualify that finding and continue reviewing what the local evidence supports. To trace an earlier model-specific recommendation, consult the [source notes](references/sources.md).
- An explicit request to edit a file covers that file, including a named global instruction file or skill. For shared files, other projects, or plugin caches outside the requested scope, report relevant findings only. Preserve unrelated changes and respect higher-priority session and system instructions.

## Review and revision

For a review, give findings, their impact, and suggested edits. When the user requests changes, make the authorized edits and check the final diff. Honor requests to see a plan first or wait for confirmation.

Trace each relevant rule to its source and where it takes effect. Consider these questions when they affect the task.

- Which decision would the rule change, and in what task? When proposing removal or consolidation, identify the duplicate rule, the extra work, or a specific situation where the rule conflicts with the user's goal. Support claims about model capabilities with evidence.
- Look for conflicting or repeated rules, overly broad triggers, lengthy procedures, unconditional reading requirements, approval at every step, and fixed quotas for searches, tests, or delegation.
- Check whether a preference has become a prerequisite or the same rule is maintained in several files. Where appropriate, keep one authoritative version and reference it elsewhere. Introduce routing only when there are several complex workflows to choose among.
- If an instruction could cause work to stop at a plan, a progress update, or an unresolved detail, identify the clause. Explain which reversible decision the agent could make, what work could continue, and how to tell when the requested outcome is complete.
- Check whether writing instructions encourage stock phrases, invented terminology, or repeated conclusions. When the effect matters, suggest concrete wording, such as leading with the finding and giving an example of its impact. Use lists and terminology when they help the reader.
- Identify business facts, security and permission boundaries, compatibility constraints, release approvals, and fragile workflows that the instructions protect. Preserve the supporting evidence, required order of operations, and conditions that require work to stop.

Resolve questions from existing files and context. Make reversible choices about wording and placement within scope. Ask about a specific decision when it would expand the edits, change the user's authorization, or require the user to resolve a material tradeoff. Complete independent work first and show a draft or diff that makes the outstanding decision clear. If a rule requires a pause, identify the file, clause, and effect.

Prefer to resolve conflicts or consolidate duplicates where the rules are defined. Update affected links and references. After an interruption, verify the current file state and resume the unfinished work.

## Verification and delivery

Check the final diff for consistency and verify that references resolve. When the skill structure changes, use an available structure validator. Run application builds, full test suites, or independent agent reviews only when the impact or a project requirement warrants them. Preserve required project checks.

Tie each finding to a specific clause, explain the consequence in a reachable scenario, and suggest an edit. After making changes, describe the effect on behavior, the checks performed, and any unverified points that affect the conclusion. Report token savings only when measured.
