# Model guidance and historical sources

These notes were first compiled on 2026-09-07. Consult them when tracing a specific recommendation. For a rule about another model, use sources that cover that model.

## GPT-6.2 Astra

Reviewed on 2026-11-18. OpenAI describes this model's default writing as more concise and direct and suggests revisiting broad brevity instructions when migrating. When intent is unclear, the model may still propose a next step and wait for confirmation. For long tasks, check whether the instructions identify the deliverable, the details the agent can decide, and the decisions that require the user. [GPT-6.2 writing style](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.2-astra#writing-style) · [Task completion](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.2-astra#task-completion)

## GPT-6 Astra

The GPT-6 Astra edition of the official guide was checked on 2026-11-18. Its URL uses `model=gpt-6-astra`. Omitting the parameter or including a trailing period in its value can select a different edition. Verify the model selected on the page and the relevant section before citing its behavior. [OpenAI's Using GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#prompting-best-practices)

- **Writing style.** The guide recommends choosing terms for the audience, leading with the point, using specific verbs and examples where needed, and cutting stock phrases, invented labels, and repetitive endings. During a review, examine the wording a rule encourages. Avoid maintaining a list of banned words. [Personality and writing style](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#personality-and-writing-style)
- **Task completion.** For action requests, identify the outcome the user expects. Continue when details can reasonably be inferred. When approval is needed, first prepare something the user can review. Check whether a clarification or approval rule blocks work the user has already authorized. [Initiative and follow-through](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#initiative-and-follow-through)
- **Instruction conflicts.** A single ambiguous skill rule can cause a task to end early. Trace the pause to the file and wording that triggered it, then check how that clause and the user's current request each apply. [Instruction following](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#instruction-following)

The guide also discusses choosing when to delegate based on the workflow and selecting checks based on the impact of a change. Preserve required project checks and avoid imposing a fixed delegation count or a full test run on every task.

## Eric Provencher's observations

[Rethinking skills and prompts for GPT-6 Astra, original post by @pvncher](https://x.com/pvncher/status/2095991462416490862) · [Original article](https://x.com/i/article/2095989703967125509)

The author suggests using short, precise skill descriptions, loading references on demand, and routing among distinct complex workflows. The article also identifies costs in reading an entire repository up front, following lengthy procedures, and requiring approval at every step. Treat these as observations from the author's practice. Whether to remove a procedure depends on the project.

The original review covered the full article and both figures. When the original page was unavailable, the public mirror returned author metadata and the article body in `tweet.article.content.blocks`. If using the mirror, verify the author, post ID, article body, and any missing media before claiming a full reading. Attribute the article to its author. [FxTwitter post data](https://api.fxtwitter.com/pvncher/status/2095991462416490862)

Retrieve the figures again only when the user asks for a complete reading or a finding depends on their contents. [Figure 1](https://pbs.twimg.com/media/HRZ0MiYaIAAeAdI.jpg) · [Figure 2](https://pbs.twimg.com/media/HRZ0VrCbwAAtwtk.jpg)

## Applying the sources

Use sources to explain specific edits and check their relevance against the current instructions, code, and validation tools. Remove unnecessary procedural work while preserving business, permission, compatibility, and release constraints. If a source is unavailable or the applicable model is uncertain, disclose the limit on the affected finding. Continue addressing duplicates and conflicts supported by local evidence. Verify claims about model capabilities before using them to justify an edit.
