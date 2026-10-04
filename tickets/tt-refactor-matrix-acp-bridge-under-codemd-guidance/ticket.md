+++
name = "Refactor matrix-acp-bridge under CODE.md guidance"
creation_date = 2026-10-04T02:27:17Z
status = "pending"
+++

# Refactor matrix-acp-bridge to the highest practical code quality

Refactor matrix-acp-bridge, guided by every recommendation in `/home/chad/code/code.voegele.me/chad/agents/CODE.md`. Deliver a tested, reviewable pull request—not merely an assessment or design.

Repository: `/home/chad/code/github.com/chadvoegele/matrix-acp-bridge`. The current default-branch worktree is `main`; verify the remote and default branch before proceeding.

## 1. Understand the guidance and existing behavior

Read CODE.md completely. Treat every individual recommendation as a review criterion. Record a concise assessment identifying supporting evidence, shortcomings, intended remedies, or reasons no change is needed. Treat the listed books as conceptual references, not required reading.

Read repository instructions, README, configuration example, specifications, design documents, implementation, and tests. Trace actual behavior rather than assuming documentation or tests are complete.

Inventory supported functionality and contracts, including:
- Matrix authorization, message filtering, synchronization, and restart catch-up.
- Room/thread routing, conversation identity, and ACP session persistence.
- ACP stdio transport, prompts, updates, activity rendering, and cancellation.
- Plaintext/encrypted messages, crypto persistence, bootstrap, and SAS verification.
- Response formatting and chunking, typing indicators, and read receipts.
- Queueing, concurrency, limits, timeouts, startup, shutdown, and resource cleanup.
- Configuration, CLI behavior, diagnostics, and durable state.

Distinguish intended behavior from accidental implementation details. Identify security boundaries, failure modes, and compatibility constraints. Establish the test baseline before changing code; document existing failures.

## 2. Design from scratch, then choose a refactoring path

Imagine implementing the same functionality from scratch under CODE.md, without inheriting the current file layout or abstractions.

Produce a concise design showing:
- A directional diagram of roughly 5–10 coherent components.
- Equally understandable decompositions when zooming into complex components.
- Responsibilities, interfaces, data flow, state ownership, side effects, and lifecycle ownership.
- Explicit security and persistence boundaries.
- The smallest useful abstractions and why they exist.
- A comparison with the current architecture and an incremental migration plan.

Apply ALL guidance, particularly:
- Compose components around functionality, not structural types.
- Prefer immutable data and explicit state transitions where practical.
- Choose data structures versus polymorphic interfaces based on likely extension patterns.
- Encapsulate internals without proliferating interfaces, wrappers, or generic frameworks.
- Keep names descriptive and consistent; functions should have verb-based names.
- Minimize scope and exposed APIs; name meaningful constants instead of using magic numbers.
- Give functions clear contracts, early precondition checks, and one responsibility.
- Separate calculations from side effects; make effectful operations narrowly focused.
- Remove dead code, duplication, excessive mutation, oversized functions/classes, inconsistent objects, and missing cleanup.
- Repair relevant defects rather than preserving or spreading them.
- Use comments sparingly; do not leave development logs in source.
- Treat dependencies as maintained parts of the stack; avoid gratuitous additions.
- Provide actionable user errors and diagnostic internal errors without exposing secrets.
- Use predominantly unit tests, supported by integration and user-perspective end-to-end tests.

The greenfield design is a reasoning tool, not permission for an indiscriminate rewrite. Prefer the simplest architecture that preserves functionality and makes future changes local. Retain existing code when it already meets the standard. Do not optimize for file count, abstraction count, or change volume.

## 3. Implement and verify

Work in the isolated branch/worktree supplied by WAAP. Do not modify another agent's worktree, discard unrelated changes, or merge into the default branch. Ensure the branch is pushed before the launcher removes its worktree.

Implement the design in cohesive, reviewable steps. Preserve documented external behavior, configuration compatibility, and existing durable state. Any necessary behavior correction must be explicitly documented and regression-tested. Do not silently weaken authorization, encryption, verification, limits, or failure handling.

Add characterization tests before restructuring uncertain behavior. Test through meaningful contracts rather than private implementation details. Cover successful flows, boundary conditions, failures, cancellation, concurrency, restart recovery, and cleanup as relevant to changed components.

Use the repository's existing tooling:

```sh
npm ci
npm run check
```

Inspect and run the documented end-to-end scenarios under agent_tests, including encrypted scenarios where feasible. Do not equate test-harness unit tests with a live end-to-end run. Report unavailable infrastructure and unverified behavior precisely; never claim a check ran when it did not.

Review the final diff against every CODE.md recommendation. Remove obsolete implementations and temporary scaffolding. Update architecture and operational documentation where contracts or layout changed, but keep chronological work logs in WAAP state, not source code.

## 4. Submit for review

Push the branch and create a pull request on the repository's actual hosting service (currently GitHub).

The description must include:
- Existing problems and the architectural rationale.
- The component diagram and guidance assessment, or links to committed documents containing them.
- Principal changes and compatibility considerations.
- Tests run, results, and any limitations.
- Remaining risks and deliberately deferred work.

Mark human-facing descriptions and comments "Chad's Agent." Request review from Chad; on GitHub resolve the appropriate account rather than assuming the GitLab username applies. The repository owner is chadvoegele; if GitHub prevents requesting the author/owner as reviewer, document this and explicitly ask Chad to review in the PR description.

Update the WAAP ticket and agent work log with the outcome, branch, review URL, and verification results. Follow WAAP's completion conventions, clearly distinguishing implementation completion from review or merge.

STOP after submitting for review. Do not merge until Chad reviews and explicitly confirms the change is ready.

Final response: review URL, concise change summary, test results, and unresolved risks.
