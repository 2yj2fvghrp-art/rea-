# GDB Durable Inferior TTY Implementation Plan

> **For agentic workers:** execute the tasks in `/tmp/rea-gdb-integration-pr` on the existing PR #1961 branch. Do not commit or push until the coordinator reviews the integrated branch.

**Goal:** Let callers select an inferior TTY at GDB startup, prove GDB retained that setting before any inferior runs, expose it in session status, and permit detaching a live inferior during shutdown only when the durable sink was configured and verified.

**Architecture:** Extend the `start_gdb_session` contract with optional `inferior_tty`. Keep the caller's path as the session's intended sink, configure it through GDB/MI before returning a ready session, and verify it through `-inferior-tty-show`; fail startup if setting or verification fails. The provider's detach callback returns the shared lifecycle contract's durable-sink confirmation only for a live, single inferior whose configured TTY was verified. With no live inferior, shutdown remains safe without a sink; with a live inferior and no verified sink, retain ownership and fail closed.

**Tech Stack:** TypeScript, Zod tool contracts, GDB/MI, Vitest, MCP in-memory client/server tests.

**Spec:** Approved durable sink contract in `src/process/ownedDebuggerSession.ts` on the lifecycle branch: detach confirmation must include `outputSink: "durable"`; otherwise cleanup remains incomplete. GDB/MI command behavior is documented by [GNU GDB MI miscellaneous commands](https://www.sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Miscellaneous-Commands.html#GDB_002fMI-Miscellaneous-Commands), which specifies `-inferior-tty-set` and `-inferior-tty-show`.

## Global Constraints

- Preserve caller-selected `inferior_tty` exactly in request/session state; do not silently canonicalize or replace it.
- Complete TTY configuration and confirmation before `start_gdb_session` succeeds and before any `-exec-run` can be issued through the session.
- Treat missing, rejected, malformed, truncated, or mismatched `-inferior-tty-show` output as unverified; do not claim durable sink confirmation.
- Detach only the active inferior after its sink is durably configured; preserve the existing fail-closed behavior for multiple or unknown inferiors.
- When there is no live inferior, allow the existing no-inferior cleanup path without requiring a TTY.
- Persist sink verification as session-start state. If the GDB leader has already exited, do not try MI; require this durable fact or keep the output drain and ownership until output/descendant settlement is confirmed.
- Never send a process signal after a failed sink verification or failed detach confirmation; preserve GDB session/process ownership.
- Keep `start_gdb_session` optional input backward compatible and expose only bounded, non-secret status metadata.

## Review Focus

- A caller omits `inferior_tty`, then a live inferior exists at close: cleanup must retain ownership and send no detach or signal.
- A TTY setting command succeeds but `-inferior-tty-show` returns a different path: startup must fail and cleanup must not claim durable sink readiness.
- The TTY path includes MI-significant characters: command encoding must preserve the supplied path and the read-back must match it exactly.
- TTY configuration returns incomplete/truncated output: startup must fail closed without recording the sink as verified.
- A configured sink exists but MI inferior enumeration is unknown or reports multiple groups: current fail-closed ownership behavior must remain.
- The GDB leader exits before close while an inferior/descendant still writes: a startup-verified durable sink allows safe release; absent/invalidated sink keeps ownership and the output drain without issuing a process signal.

---

### Task 1: Add the caller-selected TTY to the GDB MCP contract

**Files:**
- Modify: `src/contracts/gdbToolContracts.ts`
- Modify: `src/server/registerGdbTools.ts`
- Test: `tests/boundary/mcp/toolSchemaValidity.test.ts`
- Test: `tests/boundary/mcp/gdbCancellationMcp.test.ts`
- Test: `tests/boundary/cli/gdbStartupCleanupCli.test.ts` only if its fake manager is typed against the changed start signature

**Interfaces:**
- `start_gdb_session` input adds `inferior_tty: z.string().min(1).optional()`.
- `GdbSessionManager.start(signal?: AbortSignal, options?: { readonly inferiorTty?: string })` preserves all existing CLI and test callers while allowing the MCP adapter to forward the optional path.
- `gdb_session_status` adds `inferior_tty: string | null` and `inferior_tty_verified: boolean`.

- [ ] Add schema assertions that absent `inferior_tty` remains valid, a non-empty path is accepted, and empty/non-string values are rejected.
- [ ] Add an MCP start test that passes a caller-selected TTY and observes the same value in status after successful configuration.
- [ ] Forward `input.inferior_tty` from `registerGdbTools` as `manager.start(context.mcpReq.signal, { inferiorTty: input.inferior_tty })`; keep the CLI's existing `manager.start(signal)` behavior unchanged.
- [ ] Add output-schema validation for the new status fields through the advertised MCP schema.
- [ ] Confirm these tests fail before implementation because input is rejected and status fields are absent.

### Task 2: Configure and verify TTY before declaring the session ready

**Files:**
- Modify: `src/gdb/GdbSessionManager.ts`
- Test: `tests/boundary/providers/GdbSessionManagerCoverage.test.ts`
- Test: `tests/boundary/providers/GdbSessionReviewRegressions.test.ts`

**Interfaces:**
- Extend `GdbSession` with `inferiorTty: string | undefined` and `inferiorTtyVerified: boolean`.
- Extend `start` compatibly to `start(signal?: AbortSignal, options: { readonly inferiorTty?: string } = {})`; forward the optional path to the session.
- Encode the selected path as a GDB/MI C string argument using a dedicated escaping function; do not interpolate raw caller text into a command.

- [ ] Add fake-GDB regressions where `-inferior-tty-set` and subsequent `-inferior-tty-show` return the requested path, including quotes, backslashes, and Unicode.
- [ ] Add negative regressions for MI error, malformed response, truncation, timeout, and exact-path mismatch; assert startup does not report success or `inferior_tty_verified: true`.
- [ ] Place set/show commands after GDB MI startup and required safe settings, but before inserting the session into the ready session map; do not execute `-exec-run` during startup.
- [ ] Parse only a complete, untruncated `^done,inferior_tty_terminal="..."` response and compare the decoded value byte-for-byte with the caller's original string.
- [ ] If startup cannot verify the path, return a typed start error and route cleanup through `stopOwnedDebuggerProcess`; retain ownership when existing detach rules cannot establish safe cleanup.
- [ ] Run the focused provider tests and confirm verified state is only set after successful read-back.

### Task 3: Gate active-inferior detach on durable TTY confirmation

**Files:**
- Modify: `src/gdb/GdbSessionManager.ts`
- Test: `tests/boundary/providers/GdbSessionManagerCoverage.test.ts`
- Test: `tests/boundary/providers/GdbSessionReviewRegressions.test.ts`
- Test: `tests/boundary/process/ownedDebuggerSession.test.ts` only if the approved callback interface changes again

**Interfaces:**
- `GdbSession.detachInferior` returns the shared callback result: `{ status: "no-inferior" }` or `{ status: "detached", outputSink: "durable" }`.
- Return `detached` with `outputSink: "durable"` only after `inferiorTtyVerified === true` and only when exactly one active inferior has been enumerated completely.

- [ ] Add a regression with one live inferior and no `inferior_tty`: close retains session and emits no `-target-detach`, `-gdb-exit`, SIGTERM, or SIGKILL.
- [ ] Add a regression with one live inferior and a verified TTY: close issues `-target-detach`, waits for complete MI detach confirmation, then allows the helper to stop GDB.
- [ ] Add a regression where the GDB leader has already exited: only the session's startup-verified sink fact allows releasing stdout/stderr; without it, preserve the drain and ownership until settlement rather than querying MI or disposing streams.
- [ ] Add regressions proving failed/mismatched/truncated TTY read-back cannot produce a durable detach result.
- [ ] Preserve existing tests for no inferior, multiple inferiors, unknown group enumeration, detach failure, and truncated group output; verify no sink requirement is imposed on the confirmed no-inferior case.
- [ ] Update close's manual `-gdb-exit` path so a live inferior can never bypass the durable-sink-gated provider callback. Prefer one cleanup path through the shared helper; if a manual fast path remains, it must satisfy the same TTY verification and detach confirmation invariants.
- [ ] Run focused GDB lifecycle tests and inspect recorded command order: TTY set, TTY show, inferior enumeration, detach, then process stop.

### Task 4: Deliver status and document caller-visible behavior

**Files:**
- Modify: `src/contracts/gdbToolContracts.ts`
- Modify: `src/server/registerGdbTools.ts` only if status projection needs explicit shaping
- Modify: `README.md` or `docs/reverse-engineering-tools.md` at the existing GDB provider instructions
- Test: `tests/boundary/mcp/gdbCancellationMcp.test.ts`
- Test: `tests/boundary/mcp/toolSchemaValidity.test.ts`

**Interfaces:**
- Status reports `inferior_tty: string | null` and `inferior_tty_verified: boolean`; the boolean is true only after successful complete MI read-back.
- The start tool description explains that `inferior_tty` is an optional caller-selected terminal for the inferior's future runs and that a live inferior cannot be detached safely on close unless GDB confirmed the setting.

- [ ] Test status for omitted, configured/verified, and startup-failed TTY cases through the MCP client and validate each structured response against the advertised output schema.
- [ ] Document that the caller must provide a terminal that remains available after the GDB process exits; a path's appearance in status does not by itself prove the terminal consumer is still running.
- [ ] Clarify that GDB's explicit `run` redirection can override the configured terminal, so a later run-specific override may invalidate detach safety; either track explicit redirection commands and revoke verification or document that safe detach is unavailable after such an override.
- [ ] Run focused GDB provider/MCP tests, `npm run check:fast`, and `git diff --check` after the lifecycle branch's sink contract is integrated.

## Self-Review

- The contract, provider configuration, shutdown gate, status schema, docs, and tests each have an owning task.
- Tests explicitly cover omitted, valid, malformed, mismatched, truncated, and overridden sink states plus existing inferior enumeration failure modes.
- A remaining design decision for implementation review is whether unrestricted `gdb_console` commands that can override `inferior-tty` should conservatively revoke `inferiorTtyVerified`; the safe default is to revoke it when command semantics may alter inferior TTY or run redirection.
- This plan does not authorize editing GDB while the shared helper change is awaiting its independent approval. Start implementation only after the coordinator confirms the helper branch is approved and integrated.
