---
name: skill-creator
description: Guide for creating effective Agent Skills. Use when users want to create a new skill, turn a workflow into a reusable skill, or build an agent skill from scratch.
---

# Skill Creator

You help users create high-quality Agent Skills that follow the agentskills.io specification. A skill is a reusable package of instructions, scripts, references, and assets that extends an AI agent's capabilities.

## Flexible Workflow

Adapt to the user's needs. There are four modes — match the user's intent to the right one:

- **Lightweight mode**: User wants a quick skill without formal evaluation. Capture intent, write the skill, install it, and do a quick smoke test. (Phase 1 → Phase 2 → Phase 3)
- **Full evaluation mode**: User wants rigorous quality testing with before/after comparisons and metric-driven iteration. (Phase 1 → Phase 2 → Phase 3 → Phase 4)
- **Trigger optimization**: User wants to test and improve a skill's triggering accuracy. Optimize the description so the skill is triggered more reliably and with fewer false positives. (Phase 5)
- **Improve existing skill**: User wants to enhance an already-installed skill. Snapshot the baseline version, make targeted improvements, run comparative evaluations, and decide whether to adopt the new version. (Phase 6)

If uncertain which mode, ask the user to clarify. For example: "Do you want a quick skill, a thorough evaluation-driven process, trigger optimization for an existing skill, or improvements to a skill's content?"

## Phase 1: Capture Intent

Before writing anything, understand what the user needs. Extract as much as possible from the conversation first, then ask targeted questions.

### Extract from Conversation History

If the user says "turn this workflow into a skill" or similar, review the conversation history to identify:
- The sequence of steps performed
- Tools and commands used
- Corrections the user made (these are especially valuable — they reveal edge cases the skill should handle)
- Input/output formats and expected outputs

### Synthesize from Provided Materials

If the user provides documents, runbooks, code review records, or other project artifacts, extract reusable skill knowledge from them. Focus on project-specific conventions and edge cases that a general-purpose agent wouldn't know.

### Key Questions to Clarify

Ask only what isn't already clear from the context. Adapt your terminology to the user's technical level — avoid terms like "JSON" or "assertion" with non-technical users unless you briefly explain them.

1. **Purpose**: What exactly should this skill help the agent do?
2. **Trigger**: When should the agent use this skill? What user phrases or contexts should activate it? Be specific — "when working with Python code" is better than "for coding tasks."
3. **Expected output**: What should the agent produce? A file? A structured report? A specific action?
4. **Edge cases**: What unusual situations might arise? What should the agent do differently in those cases?
5. **Input/output formats**: Are there specific file formats, schemas, or data structures involved?
6. **Success criteria**: How will the user know the skill works well? What does "good" look like?
7. **Dependencies**: Does this need specific tools, libraries, or environment setup?
8. **Scope**: Is this for the current project only, or reusable across projects?

Do NOT proceed to writing the skill until these questions are sufficiently answered. Come prepared with context from the conversation to minimize the burden on the user.

## Phase 2: Write the Skill

### Directory Structure

A skill package lives in a directory whose name matches the skill name:

```
skill-name/
├── SKILL.md          # Required: frontmatter + instructions
├── scripts/          # Optional: executable scripts (Python, bash, etc.)
├── references/       # Optional: documentation loaded on demand
└── assets/           # Optional: templates, icons, static resources
```

Use the `create_file` tool to create files. It automatically creates parent directories.

**Where to create the skill**: All skills under construction go to `~/.chill/skills-dev/` — a development workspace separate from the live `~/.chill/skills/` installation directory. This is the industry standard: Claude Code uses `~/.claude/skills/`, OpenAI Codex uses `~/.agents/skills/`. Neither asks the user where to create skills; the location is a platform convention. Inform the user of the path, then proceed directly.

- **Lightweight mode**: Create the skill at `~/.chill/skills-dev/{skill-name}/`. Install it immediately after Phase 3 validation.
- **Full evaluation mode**: Create the skill at `~/.chill/skills-dev/{skill-name}/`. Evaluation artifacts will be written to a sibling `~/.chill/skills-dev/{skill-name}-workspace/` directory. Do NOT install the skill yet — evaluation happens before installation.

### SKILL.md Frontmatter

Write valid YAML frontmatter between `---` delimiters. Required fields:

- **name**: Lowercase letters, digits, and single hyphens only. No leading/trailing/consecutive hyphens. Max 64 characters. Must exactly match the parent directory name. Regex: `/^[a-z0-9]+(-[a-z0-9]+)*$/`
- **description**: 1-1024 characters. This is the PRIMARY mechanism for triggering the skill. Write it in imperative mood, be slightly "pushy" to counter agent under-triggering, and explicitly list when to use this skill. Example: "Validate CSV files before import. Use when the user mentions CSV, data validation, file checking, or data quality, even if they don't explicitly say 'validate'."

Optional fields:
- **license**: SPDX identifier (e.g., "Apache-2.0", "MIT")
- **compatibility**: 1-500 characters describing environment requirements
- **metadata**: Arbitrary key-value pairs for author, version, etc.
- **allowed-tools**: Pre-approved tool list (experimental)

### SKILL.md Body: Writing Principles

**Size limit**: Keep the body under 500 lines or 5000 tokens. If you exceed this, split detailed reference material into `references/` files and tell the agent when to load each one.

**Start from real expertise, not LLM knowledge**: Add what the agent lacks (project-specific conventions, edge cases). Omit what it already knows (general programming concepts). The skill's value is in the specialized knowledge it adds.

**Six Effective Instruction Patterns** — use these where appropriate:

1. **Gotchas**: Environment-specific pitfalls the agent is likely to hit. E.g., "This project uses ESLint flat config, not .eslintrc — the config file is eslint.config.js."
2. **Output templates**: Give the agent a concrete format template to follow. Agents are good at pattern-matching against examples.
3. **Checklists**: Explicit step-by-step checklists help the agent track progress through multi-step workflows.
4. **Validation loops**: "Do the work → run the validation → fix issues → repeat until clean." Essential for code generation and data transformation skills.
5. **Plan-validate-execute**: For batch or destructive operations, have the agent build an intermediate plan first, get it validated, then execute. Prevents cascading errors.
6. **Bundling reusable scripts**: If the agent repeatedly regenerates the same logic, bundle it as a tested script in `scripts/`. Reference scripts by relative path from SKILL.md and list available scripts.

**Context cost principles**: Provide defaults, not menus (pick one good approach, briefly mention alternatives). Favor procedures over declarations (teach the agent *how to approach* a class of problems, not *what to produce*).

**Writing style**: Explain *why* rather than piling up MUST rules. Make instructions general — applicable across similar situations, not overfitted to one example. Write a draft, then review with fresh eyes.

**Security baseline**: The skill must not contain malicious code, exploit code, or any content that could harm system security. Do not assist in creating skills for unauthorized access, data exfiltration, or other malicious purposes. Principle of least surprise — the skill's behavior should be obvious from its name and description.

### scripts/ Guidelines

Scripts are optional. Use them when the agent would otherwise repeatedly regenerate the same logic. Design requirements:

- **Non-interactive**: Accept input via CLI arguments, environment variables, or stdin. Never prompt for TTY input.
- **Self-documenting**: Implement `--help` with description, parameters, and usage examples.
- **Useful errors**: When something fails, say what went wrong, what was expected, and how to fix it.
- **Structured output**: Prefer JSON or CSV over free-form text. Data to stdout, diagnostics to stderr.
- **Idempotent**: "Create if not exists" is better than "create and fail on duplicate."
- **Dry-run support**: Add `--dry-run` for destructive operations.
- **Meaningful exit codes**: Document them.
- **Safe defaults**: Destructive operations require `--confirm` or equivalent.
- **Predictable output size**: Default to summary for large outputs. Support `--offset` for pagination.
- **Self-contained dependencies**: Python PEP 723 (`/// script` dependencies), Deno `npm:` specifiers, or Bun auto-install. No manual `pip install` / `npm install` steps.

### references/ Guidelines

Optional documentation files loaded on demand. Best practices:

- Each file focuses on one topic. Keep files small — the agent loads them individually, so smaller files save context.
- Files over 300 lines should include a table of contents.
- In SKILL.md, explicitly tell the agent *when* to load each reference file. E.g., "If the API returns a non-200 status code, read `references/api-errors.md`."

### assets/ Guidelines

Optional static resources (templates, icons, data files) used as output building blocks. Reference them by relative path from SKILL.md.

## Phase 3: Validate and Install

### Step 1: Validate the SKILL.md

After writing `SKILL.md`, validate it against these rules before installation:

1. **name format**: Must match `/^[a-z0-9]+(-[a-z0-9]+)*$/`. Only lowercase letters, digits, and single hyphens. No leading/trailing/consecutive hyphens.
2. **name length**: Max 64 characters.
3. **name matches directory**: The `name` in frontmatter must exactly match the parent directory name. If your skill is in `my-skill/SKILL.md`, the frontmatter name must be `my-skill`.
4. **description required**: Must be present and 1-1024 characters long.
5. **compatibility** (optional): If provided, must be 1-500 characters.

If validation fails, fix the issue and re-check. Do not proceed to installation until all checks pass.

### Step 2: Install or Proceed to Evaluation

**In lightweight mode**: Install the skill immediately using `install_skill`:

```
install_skill({source: "/absolute/path/to/skill-directory"})
```

The tool will copy the skill to `~/.chill/skills/<skill-name>/` and reload the skill registry. The skill is immediately available.

**In full evaluation mode**: Skip installation. Proceed to Phase 4 for evaluation-driven iteration. You will install the skill only after all evaluation rounds pass and the user approves.

### Step 3: Confirm

After installation, confirm to the user:
- The skill name and where it was installed
- How the user can test it (e.g., "Try saying 'use my-skill to...'")
- That they can override the built-in version by placing a skill with the same name in their personal or project directory

## Phase 4: Evaluation-Driven Iteration

Full evaluation mode only. Skip this entire phase in lightweight mode.

### Step 1: Design Test Cases

Create `{skill-name}/evals/evals.json` with 2-3 test cases using the `create_file` tool. Format:

```json
[
  {
    "id": "eval-1",
    "prompt": "The user prompt to test (simulate a real user request)",
    "expected_output": "Brief description of what a good output looks like",
    "files": [],
    "assertions": []
  }
]
```

Quality requirements:
- Vary phrasing styles across test cases: one formal, one casual (with typos if realistic), one edge case
- Use real-world context: actual file paths, column names, or domain terminology the user mentioned
- Leave `assertions` as empty arrays — you will fill them in after the first run

### Step 2: Write Assertions

After the first round of runs (Step 3), update `evals/evals.json` with assertions for each test case.

Each assertion must be **programmatically verifiable or concretely observable**. Avoid vague judgments.

Good assertions:
- "The output includes a bar chart image file"
- "The chart shows exactly 3 months of data"
- "The review mentions at least 2 security vulnerabilities by name"

Weak assertions (avoid):
- "The output is good"
- "The result looks correct"
- "The response is helpful"

### Step 3: Run Evaluations — Dual Scenario

For each test case in `evals/evals.json`, perform two role-play runs in the same conversation.

**Baseline (without skill)**: Do NOT read the target SKILL.md. Process the test `prompt` as a generic request using only your general knowledge. Ignore the skill-creator's own instructions during baseline — focus solely on the test prompt. Save the output to:
```
{skill-name}-workspace/iteration-N/{eval-id}/without_skill/outputs/
```

**With skill**: Read the target `{skill-name}/SKILL.md` first, then process the same test `prompt` following the skill's instructions. Save the output to:
```
{skill-name}-workspace/iteration-N/{eval-id}/with_skill/outputs/
```

Use `create_file` to save outputs (it creates parent directories automatically).

Record timing data in `{skill-name}-workspace/iteration-N/timing.json`:
```json
{
  "eval-1": {
    "without_skill": { "tokens": 800, "duration_ms": 5200 },
    "with_skill":    { "tokens": 950, "duration_ms": 6100 }
  }
}
```
Estimate or skip if actual numbers are unavailable.

### Step 4: Grade and Aggregate

Compare each run's output against its assertions. Mark **PASS** only with specific evidence — quote the relevant part of the output. No "suspected pass" — if evidence is ambiguous, mark **FAIL**.

Generate `{skill-name}-workspace/iteration-N/grading.json`:
```json
[
  {
    "eval_id": "eval-1",
    "without_skill": [
      { "assertion": "chart includes axis labels", "result": "FAIL", "evidence": "Output has a bare chart image with no labels" }
    ],
    "with_skill": [
      { "assertion": "chart includes axis labels", "result": "PASS", "evidence": "Output includes x-axis 'Month' and y-axis 'Revenue'" }
    ]
  }
]
```

Aggregate into `{skill-name}-workspace/iteration-N/benchmark.json`:
```json
{
  "iteration": 1,
  "without_skill": {
    "pass_rate": 0.33,
    "tokens": { "mean": 800, "stddev": 120 },
    "duration_ms": { "mean": 5200, "stddev": 800 }
  },
  "with_skill": {
    "pass_rate": 0.83,
    "tokens": { "mean": 950, "stddev": 150 },
    "duration_ms": { "mean": 6100, "stddev": 900 }
  },
  "delta": {
    "pass_rate": 0.50,
    "tokens": 150,
    "duration_ms": 900
  }
}
```

Delta = with_skill minus without_skill. Omit stddev if only one test case.

### Step 5: Analyze Patterns

Read `benchmark.json` and `grading.json`. Flag these five categories:

1. **Non-differentiating assertions**: PASS in both with and without skill → remove them, they don't measure the skill's value
2. **Problematic assertions**: FAIL in both configurations → the assertion itself is likely wrong, not the skill
3. **Skill value proven**: PASS with skill, FAIL without → these assertions demonstrate the skill's effectiveness
4. **High variance**: If timing or token counts vary wildly across runs of the same configuration, flag as unstable
5. **Outliers**: Any timing durations or token counts that are significantly different from the mean of their group

### Step 6: Collect User Feedback

Present the pattern analysis to the user. For each test case, ask for specific, actionable feedback — not vague impressions.

Good feedback: "The chart is missing axis labels" or "The security review should also check for SQL injection"
Poor feedback: "Looks bad" or "Not helpful"

Save feedback as `{skill-name}-workspace/iteration-N/feedback.json`:
```json
[
  { "eval_id": "eval-1", "feedback": "Chart needs axis labels" },
  { "eval_id": "eval-2", "feedback": "" }
]
```

Empty feedback means the test case passes human review.

### Step 7: Iterate and Improve

Synthesize three signals to identify root causes and improve the skill:

1. **Failed assertions** — concrete gaps: what specific output is missing or wrong?
2. **User feedback** — overall quality issues the user noticed
3. **Execution traces** — where did the skill's instructions fail to guide effectively?

**How to improve** — follow these principles:
- **Generalize, don't patch**: If the assertion says "chart needs axis labels", don't add one line about axis labels. Add a general rule like "all visualizations must include labeled axes and a title"
- **Keep it lean**: Fewer, better instructions beat exhaustive rule lists. A short "why" explanation is more effective than five MUST directives
- **Bundle repeated logic**: If you find yourself writing the same logic across multiple test case runs, suggest packaging it into `scripts/` in the skill directory

**Blind comparison**: When comparing the old and new version of a skill, submit both outputs anonymously to an LLM for a blind judgment. This eliminates the confirmation bias that "the new version should be better."

**Iteration flow**:

1. Modify `{skill-name}/SKILL.md` using `create_file` with `overwrite: true`
2. Return to Step 1 (increment the iteration number: N+1)
3. Repeat until benchmark pass_rate meets expectations AND the user confirms
4. **Maximum 3 iterations** — if still not meeting expectations after 3 rounds, stop and report the current state to the user

**Final installation (after approval)**:

```
install_skill({source: "/absolute/path/to/{skill-name}"})
```

Use an absolute path. The skill will be copied to `~/.chill/skills/<skill-name>/` and immediately available.

**Cleanup**: After installation, inform the user:
- `{skill-name}-workspace/` can be safely deleted
- Or kept for future evaluation history if they plan to improve the skill later

## Phase 5: Trigger Optimization

Optimize a skill's `description` field so the skill is triggered more reliably (fewer missed triggers) and with fewer false positives (not triggered when it shouldn't be). This phase focuses exclusively on the description — the primary mechanism that determines whether the agent activates the skill.

Goal: test the skill's triggering accuracy, then iteratively improve the description to maximize hit rate and minimize false triggers.

### Step 1: Design Trigger Evaluation Queries

Create `{skill-name}/eval_queries.json` with the `create_file` tool. This file contains queries that test whether the skill's description would trigger the skill correctly.

JSON format:

```json
{
  "queries": [
    { "id": "q-1", "text": "User query text here", "should_trigger": true },
    { "id": "q-2", "text": "Another query", "should_trigger": false }
  ]
}
```

Query design requirements:

- **should-trigger queries (8-10)**: Phrases that should activate the skill. Cover diverse wording styles — formal, casual, with typos, and keyword variants from the skill's domain.
- **should-not-trigger queries (8-10)**: Phrases that should NOT activate the skill. These MUST be "near misses" — queries that share keywords with the skill's domain but have fundamentally different intent. Example: if the skill is for "code review", a near-miss query is "review this contract" — it shares "review" but the intent is contract review, not code review.
- **Forbidden**: Obviously unrelated queries like "what's the weather today" — these don't test description precision, they're noise.

### Step 2: Split Train/Validation Sets and Run Simulated Trigger Tests

Split the ~20 queries into a **60% training set** and **40% validation set**. List which query ids go into each group.

For each query, run **3 simulated trigger tests**: in an independent context evaluation, given the current skill description, judge whether the query would trigger the skill. The judgment standard: would the description cause the agent to activate or read this skill in response to the query?

Record results using `create_file`:

- `{skill-name}-workspace/trigger-test/train-results.json`
- `{skill-name}-workspace/trigger-test/val-results.json`

Format:

```json
{
  "q-1": { "trigger_count": 2, "total_runs": 3, "trigger_rate": 0.67 },
  "q-2": { "trigger_count": 3, "total_runs": 3, "trigger_rate": 1.0 }
}
```

**Note**: This is LLM self-assessment, not sending messages to a separate LLM instance. Since the skill-creator runs inside the LLM itself, it cannot create an independent LLM instance to test trigger behavior. Simulated self-assessment is the standard approach, consistent with Anthropic and Codex methodologies.

### Step 3: Optimize Description from Training Set Failures

Analyze **only the training set** results. Identify two failure categories:

1. **Under-triggering**: `should_trigger: true` queries that failed to trigger. The description is too narrow or misses relevant signals.
2. **Over-triggering**: `should_trigger: false` queries that triggered anyway. The description is too broad or matches unrelated intents.

**Optimization principle**: Do NOT patch by directly adding keywords from failed queries to the description. Instead, find the *general category* the failed queries represent and adjust the description at that level.

For example, if multiple queries about "checking log files" fail to trigger, don't add "checking log files" — add a broader category like "handling file content quality issues" that covers the general use case.

**Hard constraint**: `parseSkillMd` enforces description must be 1-1024 characters. After each modification, verify the description length is within range. If approaching the upper limit, prioritize refining wording over appending more content.

After each adjustment, record a version number (v1 → v2 → v3). Save each version's full SKILL.md snapshot using `create_file` to:
- `{skill-name}-workspace/trigger-test/versions/v1/SKILL.md`
- `{skill-name}-workspace/trigger-test/versions/v2/SKILL.md`
- ...and so on

### Step 4: Select Best Version Using Validation Set

Run all generated versions (including the original) through the validation set, 3 simulated trigger tests per query per version.

Calculate each version's **trigger accuracy** on the validation set:

```
accuracy = (correct_should_trigger + correct_should_not_trigger) / total_queries
```

Select the version with the highest validation accuracy as the final version.

**Writing the result back**:

- **If the skill has already been installed** via `install_skill`: First read `~/.chill/skills/{name}/.install-meta.json` to get the `sourcePath`. Write the selected version to `sourcePath/SKILL.md` using `create_file` with `overwrite: true`. Then call `update_skill` to sync the updated source to the installed directory and trigger a reload (consistent with Phase 6 Steps 3-4).
- **If the skill has not been installed yet** (during Phase 4 flow): Write the selected version to `{skill-name}/SKILL.md`. The subsequent Phase 4 Step 7 `install_skill` will handle installation.

Inform the user of the result, e.g., "v3 achieves 92% accuracy on the validation set, a 14% improvement over the original's 78%."

**If all versions score worse than the original on validation**: Keep the original description and inform the user that no improvement was found.

## Phase 6: Improve Existing Skills

Improve an already-installed skill by taking a snapshot of the current version as a baseline, making targeted enhancements, running comparative evaluations, and deciding whether to adopt the new version.

Goal: produce a measurably better version of an existing skill through a structured snapshot → modify → evaluate → compare → decide workflow.

### Step 1: Locate the Skill and Snapshot the Old Version

Determine the skill name to improve — extract it from the conversation or ask the user to confirm. Use `list_skills` to verify the skill exists.

Read the current `SKILL.md` using `read_file` from `~/.chill/skills/{name}/SKILL.md`.

Save the current version as a snapshot using `create_file`:
- `{skill-name}-workspace/improve-vN/baseline/SKILL.md` (N = improvement round, starting at 1)

If the user provided specific improvement directions (e.g., "add special handling for Python projects"), record them:
- `{skill-name}-workspace/improve-vN/improvement-goals.json`

### Step 2: Run Evaluation to Establish Baseline Data

Reuse the Phase 4 evaluation process to run full dual-scenario testing against the old (baseline) version of the skill.

If the skill already has an `evals/` directory with test cases, reuse them. If not, create test cases following Phase 4 Step 1-2.

Run the dual-scenario tests as described in Phase 4 Step 3: process the same test prompts first without the skill (baseline), then with the old version of the skill.

Save evaluation results to:
- `{skill-name}-workspace/improve-vN/baseline-results/`

### Step 3: Modify the Skill and Run New Version Evaluation

First, read `~/.chill/skills/{name}/.install-meta.json` to get the `sourcePath` — the original source directory path recorded when the skill was installed.

Modify the SKILL.md body according to the improvement goals. Principles: generalize, don't patch; keep it lean. Save the new version to `sourcePath/SKILL.md` using `create_file` with `overwrite: true`.

Run the same Phase 4 evaluation process against the modified version:

- Reuse the same test cases from Step 2
- Process the test prompts with the new version of the skill (read the updated SKILL.md)

Save evaluation results to:
- `{skill-name}-workspace/improve-vN/new-version-results/`

### Step 4: Compare Results and Decide

Compare the baseline and new-version `benchmark.json` files. Calculate the delta for each metric:

- **pass_rate** delta = new - baseline
- **tokens** delta = new - baseline
- **duration** delta = new - baseline

Also perform a **blind comparison**: review the outputs from both versions anonymously (without knowing which is which) and judge which version's overall quality is better. This approach, consistent with the blind comparison in Phase 4 Step 7, eliminates the confirmation bias that "the new version should be better."

Summarize the findings:
- Whether the new version outperforms the old on key metrics
- Whether the blind comparison favors the new version

Present the comparison results to the user and let them decide: **adopt the new version**, **roll back to the old version**, or **continue modifying**.

Actions:
- **If adopt**: Call `update_skill` to sync the source directory changes to the installed directory and trigger a reload (consistent with Phase 5 Step 4).
- **If roll back**: Use `create_file` to restore `baseline/SKILL.md` from the snapshot to `sourcePath/SKILL.md`, then call `update_skill` to sync the rolled-back version to the installed directory.
