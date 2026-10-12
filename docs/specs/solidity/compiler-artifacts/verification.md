# Compiler artifact verification

Verified on 13 October 2026 with Linux x64, Node 24.18.0, npm 11.16.0,
`solc 0.8.30+commit.73712a01.Emscripten.clang`, and bundled `evmole@0.9.3`.
Base revision: `653067d799591ce2b8fdc84e99c160ac17e2860f`.

## Executed checks

- `npm run build:cached`: passed.
- Focused parser, domain, retained-view, service, provider and MCP tests:
  75 passed; two host/optional real-engine cases skipped. Actual engine behavior
  was verified by the public lanes below.
- `npm run check`: passed typecheck, lint, formatting, unused-code, metadata
  and architecture/module-boundary checks.
- `npm run docs:check`: passed generated-document checks and both README
  consistency tests.
- CI change-scope regression suite: 86 tests passed; compiler verifier and fixture
  changes select the existing real-EVM lane. That lane runs the compiler-artifact
  verifier after the existing raw/hex verifier. Hosted execution remains CI-owned.
- `npm run verify:test-discovery`: every test file discovered exactly once.
- `node scripts/verify-solc-artifacts.mjs`: 47 public CLI/stdio-MCP cases passed;
  actual converted advertised schemas validated with Ajv 2020.
- `node scripts/verify-evm-interface.mjs`: 59 existing real EVM cases passed.

Both public lanes used an absolute `REA_VERIFY_SOLC_MODULE` selecting the pinned
compiler. The existing EVM lane also used `/usr/bin/strace`. Both verified process
lineage cleanup with zero descendants and empty stderr. The new lane covers
exact creation/deployed selection, raw/hex inference equivalence, escaped source
identities and syntax ranges, unlinked/absent objects, compiler error-only output,
downstream EOF rejection with retained compiler diagnostics, malformed references,
duplicate properties, converted schema rejection and summary parent readback.

The existing lane records absent target execution and network requests for its
traced raw/hex fixtures. Network syscalls were not independently traced for the
new compiler-JSON lane. These checks are Linux source-built workflows; other
operating systems, other compiler versions, fresh installed-package selection
and arbitrary compiler outputs remain unverified. Live model tool selection was
not evaluated; SDK schema/client checks do not establish agent discoverability.
No contract was executed.

## Completed-task cost sample

Four complete CLI invocations inspect the same owned `FirstFixture` deployed
bytes. The hex reference receives an already extracted object; `solc-json` reads
the complete owned multi-contract output and returns extra compiler provenance.
All four recovered exactly selector `0x0b3f62f5` with identical candidate rows.
The hex reference does not include manual extraction cost or provide equivalent
compiler provenance. This compares the inference portion of the workflows, not
an end-to-end replacement with identical facts or a historical executable build.

Each invocation starts fresh REA and EVM workers with Node compile caching
disabled. First and repeated runs are separated below; OS caches were not reset,
and the real verifiers had already warmed runtime files. There is no verified
cold-filesystem measurement or shared engine-result cache. Scheduling variance
in these single samples does not establish a speed change.

| Carrier / run                      | Elapsed s | CPU s | Sampled peak family RSS MiB | Response bytes | Response token estimate |
| ---------------------------------- | --------: | ----: | --------------------------: | -------------: | ----------------------: |
| hex / first fresh process          |     1.281 |  1.21 |                      387.77 |          5,001 |                   1,260 |
| solc-json / first fresh process    |     0.903 |  1.22 |                      393.72 |          9,525 |                   2,595 |
| hex / repeated fresh process       |     0.967 |  1.26 |                      383.64 |          5,001 |                   1,260 |
| solc-json / repeated fresh process |     1.677 |  1.34 |                      395.85 |          9,525 |                   2,595 |

Elapsed time includes observation overhead; CPU is GNU `time` user plus system
time for the completed command and waited children. Peak family RSS sums the
GNU-time launcher, REA and live descendants sampled via `ps` every approximately
25 ms (21–40 samples per run). It is a sampled estimate, can miss short peaks,
and can count shared pages more than once. It is distinct from virtual memory
and GNU time's maximum individual-process RSS.

Response token estimates use `tokenx@1.3.0` on the complete CLI Evidence JSON;
no model was invoked. The actual SDK-advertised EVM tool definition, including
input/output schemas, descriptions and annotations, estimates 6,516 tokens.
The corresponding hex and compiler request objects estimate 24 and 65 tokens.
The full 187-tool discovery reply estimates 763,249 tokens before client projection;
clients may present only a subset or only input schemas. Actual model task tokens,
client projection, duplicate structured/text reply overhead, retries and
historical schema-cost changes are unmeasured. Response bytes alone are not a
claim of token or latency savings. Compiler summaries omit duplicated bytecode
object and raw metadata text while retaining diagnostics and reference facts.

Reproduce the semantic fixtures with `npm run verify:solc:artifacts`. For cost
samples, generate the same pinned fixture using
`scripts/fixtures/solidity/compiler-artifacts.mjs`, select `FirstFixture` deployed
bytecode as a hex reference, run both complete CLI calls in fresh processes, and
collect command CPU plus live process-family RSS. Compiler installation and
fixture generation are excluded from the inspection costs.
