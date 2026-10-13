# Implementation plan: agent-aware deep analysis provider selection

Companion to [spec.md](spec.md). Describes the architecture, data flow, affected
modules, alternatives, and validation strategy for
[issue #2417](https://github.com/morluto/rea/issues/2417).

## Architecture

The change stays inside the existing selection path:

```
AnalysisProviderRegistry   evaluate candidates, decide the outcome
        |
        v
SessionProviderRouter      map the outcome onto an immutable route
        |
        v
BinarySession              admit, bind, retire, restore, record Evidence
        |
        v
BinarySessionStatus        project route + candidates for callers
        |
        +--> CLI adapters and MCP session tools
```

No layer is added and no provider adapter changes. Dependencies still flow
inward: the new policy module depends only on the evaluation result and domain
types, and the application layer keeps owning the decision.

## Data flow

1. `open_binary` parses the target and calls `SessionProviderRouter.resolve`.
2. `AnalysisProviderRegistry.select` discovers candidates without starting a
   client, then either resolves one concrete provider or evaluates the
   automatic set.

   For automatic selection it evaluates every candidate whose availability and
   target support hold — in parallel, bounded by the caller's `AbortSignal` —
   and hands the results to `decideAutoProviderSelection`.

3. `decideAutoProviderSelection` is pure. It classifies each evaluation as
   eligible (a resolved, identity-matched profile) or not, and returns
   `bound` (one), `selection_required` (many), or `unbound` (none). It resolves
   no installations, starts no process, and creates no client.

4. `SessionProviderRouter.selectableRoute` builds one immutable route. A route
   with no binding still carries the selection, which is what makes the
   decision — and its rejections — reportable.

5. `BinarySession.#open` serializes the transition, drains in-flight calls,
   retires the previous client, creates the new client, and probes `health`.
   On success it records one selection Evidence record and, when a profile was
   bound, selects the snapshot binding.

6. `BinarySessionStatus` projects `analysis_provider_selection_state` and each
   candidate's `eligibility`.

7. `prepareSessionExecution` refuses a deep operation whose capability is not on
   the route and asks the router for the typed reason: `ambiguous` for
   `selection_required`, otherwise `target_unsupported` or
   `provider_unavailable`.

## Affected modules

| Module                                                  | Change                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/application/binary/AutoProviderSelectionPolicy.ts` | New pure decision function and state vocabularies                                                  |
| `src/application/binary/AnalysisProviderRegistry.ts`    | Report state and eligibility; classify automatic outcomes; reason selection for unbound operations |
| `src/application/binary/AnalysisProviderEvaluation.ts`  | Record eligible/ineligible on the evaluated candidate status                                       |
| `src/application/binary/BinarySessionStatus.ts`         | Project the state and per-candidate eligibility                                                    |
| `src/application/binary/ProviderSelectionEvidence.ts`   | New deterministic, REA-attributed selection record                                                 |
| `src/application/binary/BinarySession.ts`               | Record selection Evidence on the admitting transition                                              |
| `src/application/InvestigationProviders.ts`             | Add the REA selection-policy provider identity                                                     |
| `src/contracts/toolOutputSchemaPrimitives.ts`           | Advertise the two additive wire fields                                                             |

`SessionProviderRouter`, `BinarySessionOpen`, `BinarySessionRecords`,
`BinarySessionExecution`, `providerSelectionError.ts`, and `evidence.ts` are
reused unchanged.

## Design alternatives

**Static priority matrix.** Rejected. Any fixed order encodes a claim of
universal superiority the repository cannot support: provider value depends on
the user's question (target format and architecture, required operations,
existing IDA sessions, provider-specific workflows). A matrix would also need a
maintainer to keep every future adapter's position current, and it hides the
choice from the agent that actually knows the task.

**Bind the first candidate in sorted order.** Rejected. Canonical ordering is
for stable reporting, not for preference; it would silently choose an engine.

**Return a typed `ambiguous` error and require a retry.** This is the prior
behavior. It is kept only at the operation boundary, because there the caller
has asked for analysis that cannot run. At admission it loses the parsed target,
so `binary_session` cannot report compatibility, capabilities, or rejections.

**A new `switch_analysis_provider` tool.** Rejected. `open_binary` already
serializes transitions, drains calls, retires the old client, validates the new
provider against the target, restores the previous session on failure, and
applies the profile-mismatch snapshot rules. A second entry point would have to
reproduce all of it.

**A boolean `eligible` flag.** Rejected during implementation. With an explicit
concrete `provider_id`, REA evaluates only the requested provider, so an
unrequested candidate's profile was never resolved. `false` would have reported
an omission as a rejection; the three-state `eligibility` keeps it unknown.

**Nullable selection with no state field.** Rejected. `binding: null` cannot
distinguish "no provider can serve this target" from "several can and the caller
must choose", and consumers would have to re-derive eligibility from
`availability` and `target_support`, duplicating the policy at every consumer.

## Validation strategy

- **Pure policy tests** (`AutoProviderSelectionPolicy.test.ts`): zero, one, two,
  and four eligible candidates; ineligible and unevaluated exclusion; ordering
  stability.
- **Registry tests**: registration-order independence, three-candidate ties,
  available-but-incompatible, unavailable, unresolvable, and invalid profiles,
  precedence, explicit rejection, cancellation during automatic evaluation, and
  the operation-boundary reasons.
- **Composition tests**: no speculative start, no fallback, retained fast path,
  provider switching, cancellation during a switch, Evidence retention and
  identity, and cleanup.
- **Evidence tests** (`ProviderSelectionEvidence.test.ts`): attribution,
  subject binding, the three separated statement kinds, rejection retention,
  rule vocabulary, limitation text, and digest stability.
- **MCP boundary tests**: the complete external-agent workflow over
  `InMemoryTransport` — admit, inspect `binary_session`, observe the typed
  premature-operation error, reopen with a concrete provider, analyze, and
  confirm the binding.
- **Static and documentation checks**: `verify:test-discovery`,
  `verify:module-boundaries` (via lint), `check:fast`, `check`, and
  `docs:check`.

## Performance considerations

- Token cost: the new state is one short enum per session and one enum per
  candidate; no extra MCP call is required for the single-provider case, and the
  selection-required case replaces a failed call plus a retry with one
  successful admission.
- Analysis time: `selection_required` performs exactly the profile probes that
  the prior `ambiguous` path already performed, so it adds no provider work. The
  retained reopen fast path is unchanged, and the selection Evidence record is
  skipped there.
- Memory: the Evidence record stores no candidate capability snapshot, and an
  equivalent decision produces an identical digest, which the ledger records as
  a duplicate rather than a second record.
- The explicit `provider_id` path still evaluates only the requested provider;
  `eligibility: "unevaluated"` makes that omission visible instead of implying
  a rejection.

## Remaining work

The public field names, the default-on behavior, and the exclusion of a
caller-supplied rationale need a maintainer decision. Real-engine verification
on a host with two configured deep providers is not part of this branch.
