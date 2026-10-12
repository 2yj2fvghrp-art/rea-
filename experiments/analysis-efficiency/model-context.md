# Observe the client boundary before claiming token savings

Continues [#2016](https://github.com/morluto/rea/issues/2016) after the managed
summary [PR #2413](https://github.com/morluto/rea/pull/2413) merged as
`82cfcee19f18b0eeae9a330ba04e0411cdf85225`. That opt-in view has verified smaller
delivery and complete-default migration, while its original real-model cohort
does not establish token savings. This follow-up measures why raw reply bytes
and aggregate model usage cannot be treated as interchangeable observations.

## Concrete diagnostic observation

An individual real Codex CLI 0.161.0 control uses frozen runtime
`ae8051302b5834322fa00cfa31c968ae74ab6ed9`, the unchanged ShareX identity question,
requested `gpt-5.6-terra` high and the same two enabled REA tools. A private
diagnostic copy removes the original runner's explicit `--ephemeral` flag.
Authentication/profile cleanup still runs; only selected tool/usage items are
retained after filtering the owned rollout. Its source rollout SHA-256 is
`d4df41d6187880d177f00b7533d85ad032c9c4ec502a39e7d5a566180e10461b` and the retained
filtered-item SHA-256 is
`0d5b4fb67c5674d1ba14ac32ae37e9a72b0368f4d9f5f9f81eb4d13193cda260`.
The original whole-copy is removed; account metadata, world state, messages and
internal passthrough are not retained in the filtered receipt.

Despite the requested `direct` configuration label, the observed client uses
three JavaScript `exec` calls. First it filters `ALL_TOOLS` with a broad
`/REA|reverse|artifact|managed|assembly|metadata/i` expression and prints matching
metadata. The client reports truncation of a 164,005-token original output.
This is the client's output measurement, not billed input or a complete inventory.
Next it invokes complete managed inspection but selects requested normalized
identity/classification fields before printing. Finally it invokes native-boundary
inspection and prints selected fields. The actual original complete MCP replies
remain available in the separate public-event transcript.

The persisted custom-tool output values are 41,704 / 2,154 / 13,489 UTF-8 bytes.
These are the serialized recorded output **values**, not raw wire bytes or exact
submitted model requests. The trace reports four per-response usage observations:

| Response |  Input | Cached input | Output |
| -------- | -----: | -----------: | -----: |
| 1        | 10,400 |            0 |    132 |
| 2        | 19,992 |        9,984 |    456 |
| 3        | 21,242 |       19,200 |    251 |
| 4        | 24,799 |       20,224 |  1,535 |

Their totals match public turn usage: 76,433 input, 49,408 cached, 27,025 uncached
and 2,374 output, with 61.436 seconds observed wall time. Two MCP calls alone do
not describe the client's discovery/execution rounds. This proves the observed
control can project a complete result before printing it; it does not establish
that every earlier control/candidate did the same, or attribute every token
difference to discovery. The earlier `direct` label specifies requested client
configuration, not a verified absence of an executor.

Initial transcript-capture attempts retained empty source lists because the
original runner intentionally passed `--ephemeral`. A first private flag-removal
edit missed its newline and failed; that candidate remains an unsuccessful
capture attempt. The later corrected control is an individual diagnostic,
not a comparable pair with that candidate. Other exploratory aggregates remain
private and are not silently folded into the original four-trial cohort.

## Reproducible optional capture

`agent-trial.py --capture-tool-context` omits `--ephemeral` only for that explicitly
selected temporary trial. Its default is unchanged. The profile still disappears
in `finally`, including when capture fails. The capture reads only its owned
`sessions/*.jsonl` records, rejects symlink sources, and retains:

- Custom/function tool calls and replies, preserving call IDs and exact values.
- Per-response token counts and cumulative counts, with original response IDs.
- Client token-count events, retaining explicit unknown `info: null`.

It excludes session/account metadata, world state, user/developer messages,
encrypted reasoning, internal passthrough and unknown nested usage fields. It
does not copy authentication, configuration or the ambient environment. Receipts
record source/retained digests, event counts, malformed-line failures and missing
rollouts as unavailable. Capture is an observation of persisted client items,
not proof of the exact request accepted by a remote model service.

Run the same frozen runtime, question, tool selection and capture mode on both
sides. Preserve source/settings hashes and separate requested versus observed
behavior. Use the existing resource wrapper with unchanged one CPU, 4 GiB hard
memory, 3 GiB early-stop, no swap and task/host safeguards. Final physical counters
remain unknown when transient cgroups disappear; this instrumentation does not
repair that measurement limitation.

The four focused Python tests run through the existing CI `test:python` gate.
They cover account/ambient exclusion while preserving caller data, malformed and
missing records, foreign symlinks, and capture failure without copied-credential
leakage. The cleanup test simulates a CLI and establishes only cleanup semantics;
it is not real-model/provider evidence. New paired live capture and narrowly
guided discovery experiments remain to be measured before a recommendation.
