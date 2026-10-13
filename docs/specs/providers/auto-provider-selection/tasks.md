# Tasks: agent-aware deep analysis provider selection

Tracking for [issue #2417](https://github.com/morluto/rea/issues/2417) on branch
`feat/auto-provider-selection-2417`. States reflect what was actually completed
in this branch, including what was verified and what was not.

## Phase A — Baseline

- [x] Inspect repository architecture, contribution rules, and provider
      selection implementation.
- [x] Confirm the working branch and that the working tree had no unrelated
      changes.
- [x] Verify the pinned toolchain against the checkout: `.nvmrc` requests Node
      `24.18.0` and `package.json` requests npm `11.16.0`; the host ran Node
      `26.3.0` with npm `12.0.2`, which satisfies `engines.node`
      (`^22.19.0 || ^24.11.0 || >=26.0.0`).
- [x] Install locked dependencies with `npm ci` (exit 0).
- [x] Record baseline focused-test results: 4 files, 15 tests, all passing.

## Phase B — Design

- [x] `docs/specs/providers/auto-provider-selection/spec.md`.
- [x] `docs/specs/providers/auto-provider-selection/plan.md`.
- [x] `docs/specs/providers/auto-provider-selection/tasks.md`.
- [x] Document why the agent-aware design was chosen over a static priority
      matrix, and record the remaining maintainer decisions.

## Phase C — Regression tests

- [x] `AutoProviderSelectionPolicy.test.ts`: zero, one, two, and four eligible
      candidates; ineligible and unevaluated exclusion; ordering.
- [x] `AnalysisProviderRegistry.test.ts`: registration-order independence, three
      eligible candidates, available-but-incompatible, unavailable, unresolvable
      and invalid profiles, precedence, explicit rejection, cancellation during
      automatic evaluation, and the operation-boundary reasons.
- [x] Replace the two assertions that expected `ambiguous` on the initial
      `open_binary`. Both were rewritten to assert the admitted
      `selection_required` state plus a typed `ambiguous` error at the operation
      boundary; no assertion was simply deleted.
- [x] `providerBinding.test.ts`: selection-required lifecycle, no speculative
      start, retained fast path, Evidence retention and identity, no fallback,
      switching, cleanup.
- [x] `ProviderSelectionEvidence.test.ts`: attribution, subject binding,
      separated observation/decision/rationale fields, rejection retention, rule
      vocabulary, limitation text, digest stability.
- [x] `providerSelectionMcp.test.ts`: the complete external-agent workflow over
      `InMemoryTransport`.

## Phase D — Core implementation

- [x] `AutoProviderSelectionPolicy.ts`: pure `decideAutoProviderSelection`, plus
      the `ProviderSelectionState` and `ProviderCandidateEligibility`
      vocabularies.
- [x] `AnalysisProviderRegistry.ts`: report the state and per-candidate
      eligibility, classify automatic outcomes, and select the reason for an
      unbound operation.
- [x] `AnalysisProviderEvaluation.ts`: record eligible/ineligible on the
      evaluated candidate status.
- [x] `SessionProviderRouter`, `BinarySessionOpen`, and `BinarySessionExecution`
      reused unchanged.

## Phase E — Contracts and Evidence

- [x] `BinarySessionStatus.ts` projects `analysis_provider_selection_state` and
      `analysis_provider_candidates[].eligibility`.
- [x] `toolOutputSchemaPrimitives.ts` advertises both additive fields.
- [x] `ProviderSelectionEvidence.ts` creates the deterministic, REA-attributed
      selection record and reuses `createEvidence` for identity and integrity.
- [x] `BinarySession.ts` records it on the admitting transition and treats a
      recording failure as a failed open with the existing retry/restore path.
- [x] Confirm the record never carries an analysis profile and never enters the
      snapshot replay cache.

## Phase F — MCP integration

- [x] Demonstrate admit, inspect, premature-operation error, explicit reopen,
      analysis, and binding through the MCP `InMemoryTransport` boundary.

## Phase G — Documentation

- [x] Update `.agents/skills/reverse-engineer-anything/SKILL.md` with the
      candidate inspection and selection workflow, including the instruction not
      to treat availability as proof of fidelity.
- [x] Update `docs/mcp-contracts.md` selection and discovery semantics.
- [x] Update `docs/cli.md` multi-provider guidance.
- [x] Update `docs/installation.md`: its readiness guidance still described the
      removed pre-admission `ambiguous` failure.

## Phase H — Verification

Recorded on Windows 11 with Node.js `26.3.0`, npm `12.0.2`. Every comparison
below was produced by running the same command on the stashed baseline and on
this branch, then diffing the failing test files.

- [x] `npm ci` — exit 0.
- [x] `npm run test:focused -- <affected files>` — 7 files, 49 tests, passing.
- [x] `npm run test:fast` — 400 passed / 27 failed files after, against 398 / 27
      before. The 127 failing tests are identical on both trees and pre-existing
      on this host (symlinks, executable bits, `listen EACCES`, and uninstalled
      Ghidra/IDA/Hopper/WABT toolchains). The branch contributes the two new
      test files only.
- [x] `npm run test:mcp` — 86 passed / 20 failed files and 56 failing tests
      before and after. No new failures.
- [x] `npx vitest run --project boundary --project cli-boundary --project
      process-boundary --project process-global` — 219 passed / 154 failed files
      before and after. No new failures.
- [x] `npm run verify:test-discovery` — "Discovered all 1026 test files exactly
      once."
- [x] `npm run check:fast` — exit 0 (typecheck and lint, including
      `verify:module-boundaries`).
- [x] `npm run knip`, `npm run metadata:check`, `npm run
      verify:architecture-guards` — exit 0.
- [ ] `npm run check` — fails only at `format:check` for
      `src/ghidra/GhidraDoctor.test.ts` and
      `src/ghidra/GhidraSnapshotCache.test.ts`. Both files are unmodified in this
      branch, so the failure predates the implementation and was left untouched.
- [x] `npm run docs:generate` then `npm run docs:check` — exit 0.
- [x] `npm run test:focused -- tests/boundary/mcp/toolSchemaValidity.test.ts
      tests/boundary/mcp/serverIdentity.test.ts
      tests/acceptance/tools/localToolContracts.test.ts
      src/contracts/sessionPathInputs.test.ts` — 36 passed, 4 skipped.
- [x] Re-record two tests that asserted exact Evidence totals:
      `tests/boundary/mcp/sessionMcpHarness.ts` and
      `tests/boundary/mcp/sessionMcp.test.ts` now derive the totals and assert
      the selection record explicitly instead of a magic number.

Unverified on this host: real Ghidra, Hopper, and IDA providers; POSIX-only
lanes; `npm run check:pr` (skipped for time; its component checks were run
individually); and `npm run test:acceptance`, which needs a full
`npm run build:cached`.

## Phase I — PR preparation

- [x] Review the diff for scope, compatibility, formatting, and incomplete
      tests.
- [x] Prepare the commit message and Draft PR description (see the report
      accompanying this branch).
- [ ] Do not push, comment, or open the remote Draft PR without explicit
      approval.

## Not done in this branch

- Real-engine verification on a host with two configured deep providers
  (Ghidra + IDA or Hopper). Simulated providers do not establish real provider
  behavior.
- A caller-supplied selection rationale input. The Evidence record reserves
  `caller_rationale` and always writes `null`.
- Any change to a provider adapter, to execution or mutation authority, or to
  the tool catalog.
- Windows symmetry: the engine runs its checks on this host, so POSIX-only
  lanes remain unexecuted here.
