# Task-scoped preset lifecycle verification

Continues [#2016](https://github.com/morluto/rea/issues/2016) after
[#2308](https://github.com/morluto/rea/pull/2308) merged. This increment verifies
existing caller-selected Ghidra settings and immutable JSON snapshots through
actual public CLI/MCP workflows. Production defaults, provider selection and
public contracts remain unchanged; an engine database cache is still deferred.

Runtime baseline is main `f76163c2467db623f9de0bda757c9d8610ca9565`, built with
Node 24.18.0 and matching locked dependencies. Real Ghidra 12.1.4 uses the
existing caller-supplied JDK 21 and 768 MiB Java heap under one CPU. No target
execution, annotation or attached GUI database operation is requested.

## Small shipped input and profile boundaries

The first input is the installed `/usr/bin/true`, 35,664 bytes, SHA-256
`c79bf44242829108e323378531f4ac839513ca1fba45efd6583643526e1e9fd2`.
The local package database reports Debian `coreutils` `9.1-1` `amd64`; these are
installed-artifact observations, not independent archive authenticity proof.
The target itself is never invoked, including for version discovery. REA's
actual `list_procedures` chooses an internal, non-thunk procedure at `0x102000`.

The default profile reports `analyzer_preset: "ghidra-default"`. The selected
alternative reports `ghidra-default+disabled:Decompiler Switch Analysis` and
the exact disabled name in its analysis options. Their profile digests differ.
The selected initializer's complete normalized facts agree, while the profile
and provenance remain distinct. This does not establish equivalence for other
procedures, call graphs or applications. The earlier jq experiment found a
callee body difference; the existing default remains the recommendation.

The public [snapshot verifier](verify-preset-snapshot.mjs) checks:

- The default `analyze_function` actually produces a stored query entry and an
  authenticated original Evidence record in the exported snapshot.
- The same profile returns identical task facts, subject, parameters and profile
  through a fresh MCP connection. Its limitations explicitly mark snapshot reuse;
  its distinct response identity does not masquerade as the original record.
- A disabled profile refuses the default snapshot before headless Ghidra starts,
  then successfully analyzes the same caller-selected target with its own profile.
- Restoring the default refuses the disabled snapshot and accepts the original
  default snapshot. Original snapshot/source bytes stay unchanged.
- The existing CLI `function --provider ghidra --snapshot ... --json` returns
  the original cached Evidence identity and exact task facts without modifying
  the source snapshot.

Actual `strace` records the known headless launch command once for fresh default
and once for fresh disabled analysis, and zero times for either rejection or
accepted reuse. The audit covers that known command, not an arbitrary execution
or network-absence guarantee. Source bytes and snapshot bytes remain unchanged.

## Real cancellation and cleanup retry

The [lifecycle verifier](verify-preset-lifecycle.mjs) observes actual pending
startup before the bridge endpoint exists. It verifies the JVM's run token,
launcher relationship and native process start identity with production process
inspection primitives, then cancels through the SDK's normal request signal.
Read-only token sweeps confirm cleanup, including processes outside the old
parent chain; owned runtime/socket directories are removed. The selected target
remains open and a fresh provider query succeeds.

REA preserves the logical run ID when reimporting that selected target. A new
native process start identity proves the new generation; requiring a new logical
ID would test a different contract. No PID/path pair alone establishes ownership.

After recovery, the verifier removes write permission only from the verified,
user-owned temporary Ghidra project directory. The actual public `close_binary`
reports `cleanup_incomplete` with the retained resource and `EACCES` reason.
Permissions are restored, a second close succeeds, and token sweeps/root removal
confirm cleanup. The original executable is unchanged. This is a controlled real
filesystem failure, not a recording provider simulation. The error does not
authorize automatic retry before fixing its cause.

These observations pass for both the default and disabled-switch profiles on the
small input. The source verifier preserves verification and restoration/close
failures together, always attempts cleanup, validates the manifest at its read
boundary and publishes success only after its cleanup callbacks complete.

## Failed harness assumptions and measurement limits

Keep the initial probes and their corrections outside Git:

- A primitive-only `procedure_info` snapshot contained no replay entries. Equal
  content-addressed output after another analysis was not proof of cache reuse.
  The corrected probe requires a stored `analyze_function` entry, a cache-reuse
  marker and actual headless launch traces.
- After cancellation, activity was `not_observed`, rather than `idle`, because
  no provider activity snapshot remained. Preserve that unknown; successful fresh
  work proves recovery without relabeling absent metadata.
- Reimport preserved the logical run ID. Native start identity, not that logical
  ID, establishes the new process generation.

These were verification assumptions, not newly demonstrated REA defects. No
unrelated production repair is made. Existing defects remain in the requested
private `/tmp` record.

The initial complete snapshot/profile/CLI source run takes 91.838 seconds and
samples 1,180,246,016 peak family bytes. The real default/disabled cancellation
and permission-retry prototype takes 66.977 seconds and samples 1,040,846,848
bytes. Their last-observed CPU totals are 90.486 and 65.542 seconds respectively.
Both use one CPU, 4 GiB hard memory, 3 GiB early-stop, no swap and 192 tasks.
No scope abort occurs, but final counters disappear at teardown and remain
unverified. Sampled values are not final OOM/limit-event proof.

These are lifecycle verification costs. Discovery, profile inspection, rejection,
cleanup and syscall tracing make their call sequences different. They are not
paired completed-question performance trials, and contain no model token counts.
Explicit snapshot reuse is existing REA behavior, not a new speedup introduced by
these verifiers. Broader native inputs and failure scenarios remain follow-ups.

## Reproduction

Build the pinned runtime and supply an explicit string-valued provider settings
JSON, real Ghidra/JDK, a caller-supplied Linux strace executable and a fresh private
output directory. The snapshot verifier streams target hashes and stores actual
SDK/CLI replies, profile commitments and exec traces outside the checkout:

```sh
node experiments/analysis-efficiency/verify-preset-snapshot.mjs \
  --runtime-root ABS_RUNTIME --revision SHA --path ABS_NATIVE_TARGET \
  --providers ABS_SETTINGS_JSON --strace ABS_STRACE --output NEW_ABS_DIR
```

Select `--procedure` from actual REA evidence when the question already identifies
one; otherwise the verifier uses the actual procedure list. `--timeout-ms` is an
explicit observation window; `--disabled-analyzers` uses the existing setting.

Run cancellation/permission retry as a non-root Linux user:

```sh
node experiments/analysis-efficiency/verify-preset-lifecycle.mjs \
  --runtime-root ABS_RUNTIME --revision SHA --path ABS_NATIVE_TARGET \
  --providers ABS_SETTINGS_JSON --output NEW_ABS_DIR
```

Runtime revision is caller-supplied; keep the built/frozen runtime receipt alongside
the verifier source fingerprint. Target bytes, provider projects, raw JSON, traces
and profiles are not committed. The scripts acquire no dependencies or change
the user's installed configuration.
