# Managed artifact delivery baseline

Continues [#2016](https://github.com/morluto/rea/issues/2016) after
[#2404](https://github.com/morluto/rea/pull/2404) merged. This checkpoint pins
the complete managed workflow before implementing another optional view.
Production code and existing CLI/MCP requests are unchanged.

## Frozen control and analyst question

Control source is merged main `ae8051302b5834322fa00cfa31c968ae74ab6ed9`,
Node 24.18.0, matching locked dependencies and actual compiled stdio MCP.
The frozen `dist/`/`bridge/` file-table SHA-256 is
`7a4cec0fa4f7e929356b50a6b13472f80bd6f526221e427125370cca3ef98d00`.
Measurement source SHA-256 is
`a95d8d8e9f72c0b2b885c61907ed13054ebf7d1642f6f13b0126163840b1221a`.

Use the digest-pinned shipped ShareX DLL from [the corpus](corpus.json),
2,162,688 bytes, SHA-256
`191a191be964e434daf0f9d76d1e0d8ddce90d7e248cba2a6b5ac9577f288d53`.
The [existing model question](questions/managed.txt) requests exact identity,
complete managed classification and its evidence, frameworks and every declared
native ModuleRef/PInvoke boundary with coverage and limitations. It explicitly
excludes unrelated resource/custom-attribute inventories. Analysis reads PE/CLI
metadata without loading or executing the assembly.

The current complete result has exactly the same normalized facts as the earlier
real managed checkpoint linked from [the EVM descriptor study](evm-descriptor.md).
This comparison does not equate fresh Evidence IDs, provider versions or whole
catalogs. Original target bytes remain unchanged; SDK-converted named schemas
and actual replies validate in the public measurement workflow.

## Observed data costs

| Public operation                    | SDK result JSON UTF-8 bytes | Tool milliseconds |
| ----------------------------------- | --------------------------: | ----------------: |
| `inspect_managed_artifact`          |                   1,270,839 |           450.306 |
| `inspect_managed_native_boundaries` |                      27,913 |           142.663 |

The complete workflow, including connection/discovery and both calls, takes
3.721 seconds. The full discovered catalog is 2,482,204 compact JSON bytes;
its input definitions are 527,569 bytes. These costs include the current main
changes and are not silently substituted for an older catalog baseline.

The artifact inspection's normalized payload alone is 607,605 compact JSON UTF-8
bytes, measured with actual Node `JSON.stringify`:

| Returned collection |  Rows | Compact JSON UTF-8 bytes |
| ------------------- | ----: | -----------------------: |
| References          |    38 |                   12,153 |
| Resources           |    36 |                   10,357 |
| Custom attributes   | 1,945 |                  582,586 |

Custom attributes dominate the payload. The remaining identity, PE/CLI,
classification, metadata, framework and coverage facts are comparatively small.
`raw_result` is null. SDK result size includes both structured and text
representations; it is not the exact context a model receives or a token count.

The serial owned scope takes 4.852 seconds including the driver, samples
520,110,080 peak family bytes and records 4.699 last-observed CPU seconds.
One CPU, 4 GiB hard memory, unchanged 3 GiB early-stop, no swap and 192 tasks
remain in effect. No guard abort occurs. Final cgroup counters disappear and
remain unknown; sampled zero events are not final no-OOM proof.

## Bounded candidate and acceptance

Evaluate an explicit overview on the first artifact inspection, retaining the
unchanged complete source and returning a distinct linked view. Keep complete
identity/classification, metadata status, nullable module/MVID, assembly,
frameworks, original coverage/issues/limitations and returned-collection counts
inline. Typed pages can expose original references/resources/attributes with
their nulls, token coordinates, offsets, order and values. Returned-array
coverage must remain distinct from whole-metadata completeness.

Reuse the existing managed schemas, retained Evidence application workflow and
named registration hooks. Keep omitted/complete requests, other managed tools,
selected target/provider behavior and original export/import identities usable.
Do not strengthen historical admission to require a non-null subject or
reinterpret foreign recorded paths through this host's filesystem. Delivery
selection must not be passed to the PE/CLI parser as an analysis option.

The candidate is not implemented or measured at this checkpoint. Compare the
same completed analyst question, actual discovery/results, full default
compatibility and retained paging without producer reruns. Follow with other
shipped managed inputs, partial/unavailable metadata and real Codex trials with
strict factual/reference checks. Preserve failed or truncated transcripts.
Count total/cached/uncached input, output, calls/retries, whole-task time, CPU
and family memory before recommending a token or latency improvement. A smaller
reply alone is insufficient.

## Reproduce the control

Build and freeze the explicit source revision before editing production code.
Supply the original shipped DLL and an explicit string-valued provider dictionary
in a fresh private receipt directory:

```bash
python3 experiments/analysis-efficiency/resource-run.py -- \
  node experiments/analysis-efficiency/measure.mjs \
  --runtime-root /absolute/control-ae805 \
  --revision ae8051302b5834322fa00cfa31c968ae74ab6ed9 \
  --artifact sharex.dll --path /absolute/ShareX.dll \
  --providers /absolute/explicit-providers.json --schemas selected \
  --output /absolute/new-control-receipts
```

Raw replies, runtime copies, fingerprints and detailed resource receipts stay
outside Git. No new provider, plugin SDK, database cache or target execution is
introduced by this baseline.
