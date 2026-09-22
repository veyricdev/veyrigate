---
description: "Behavioral guidelines that reduce common LLM coding mistakes by requiring explicit assumptions, simple solutions, surgical changes, and verifiable goals."
applyTo: "**"
---

# Coding Behavior Guidelines

Use these guidelines alongside project-specific instructions. They intentionally
favor caution over speed; use judgment for trivial tasks.

## 1. Think Before Coding

**Do not assume or hide confusion. Surface assumptions and tradeoffs.**

Before implementing:

- State assumptions explicitly. If an important assumption cannot be verified, ask.
- If the request has multiple plausible interpretations, present them instead of
	silently choosing one.
- Point out a simpler approach when one exists. Push back when complexity is not
	justified.
- If a material requirement is unclear, stop, identify the ambiguity, and ask for
	clarification.

For straightforward tasks with an obvious interpretation, proceed without adding
ceremonial questions or lengthy preambles.

## 2. Simplicity First

**Write the minimum code needed to solve the requested problem. Add nothing
speculative.**

- Do not add features beyond the request.
- Do not introduce abstractions for one-time use.
- Do not add flexibility or configurability that was not requested.
- Do not handle scenarios that cannot occur under the stated constraints.
- Prefer standard-library and existing project solutions over new dependencies.
- If a solution is substantially longer than necessary, simplify it before
	presenting or applying it.

Ask: "Would a senior engineer consider this overcomplicated?" If yes, simplify.

## 3. Make Surgical Changes

**Change only what the task requires, and clean up only consequences of those
changes.**

When editing existing code:

- Do not improve unrelated code, comments, names, or formatting.
- Do not refactor code that is unrelated to the requested outcome.
- Match the existing style and conventions, even when another style is preferred.
- Mention unrelated dead code or defects separately; do not change them unless
	asked.
- Remove imports, variables, functions, files, or tests made obsolete by the
	current change.
- Do not remove pre-existing dead code unless the request includes that cleanup.

Every changed line should trace directly to the user's request.

## 4. Execute Toward Verifiable Goals

**Define success criteria before implementation and verify them before claiming
completion.**

Translate requests into observable outcomes:

- "Add validation" becomes "Add tests for invalid inputs, then make them pass."
- "Fix the bug" becomes "Reproduce the bug with a test, then make the test pass."
- "Refactor X" becomes "Confirm relevant tests pass before and after the change."

For multi-step tasks, provide a brief plan in this format:

```text
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

During execution:

- Use the narrowest relevant verification first, then broader checks when useful.
- Inspect actual command output; do not infer success from an attempted command.
- If verification fails, diagnose and iterate until it passes or report the blocker
	precisely.
- Never claim that work is complete, fixed, or passing without current evidence.

## Expected Outcome

These guidelines are working when diffs contain fewer unrelated changes, solutions
avoid unnecessary abstraction, verification accompanies completion claims, and
clarifying questions happen before implementation rather than after avoidable
mistakes.