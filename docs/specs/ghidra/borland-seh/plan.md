# Implementation plan

1. Add a Ghidra-owned producer that reads decoded instruction encodings and
   tracks exact adjacent zero-offset registration patterns. Use Ghidra's
   disassembler with a restriction set containing only unowned gaps; disable
   automatic code analysis for that command.
2. Traverse handler entry and the continuation after its RTL jump veneer.
   Add decoded reachable instructions only, stop at original body/other owners,
   and require a return to the original body or a recognized flow terminator.
   Store per-function diagnostics, including unrecovered handler addresses.
3. Run the producer once before the bridge initializes its decompiler. Supply
   its diagnostics to every function observation; preserve the existing shape.
   Bind the changed semantics into the analysis profile.
4. Verify a self-owned PE32 fixture through real Ghidra, including negative
   registration and ownership cases. Run source/static/document checks.
5. If process-group verification races with an acknowledged JVM shutdown,
   wait for the retained child exit and retry full group verification once.
   Child exit alone never authorizes runtime deletion; incomplete group
   cleanup retains its supervisor and files for a later verified close.

## Executed validation

On upstream `3620074b3`, Node 24.18.0, Ghidra 12.1.4, JDK 21 and darwin/arm64:

- Real source-owned PE32 CLI/MCP verification passed: recovered handler,
  handler-only string/call, containing procedure, nonzero FS rejection,
  independent owner preservation, immutable target and empty owned runtime.
  The observe-only policy was exercised on POSIX; a Windows host was not run.
- 117 function/provider/snapshot/MCP tests and 36 client lifecycle tests
  passed, including retry after acknowledged shutdown and retained ownership
  when full group verification still fails. Static checks passed.
- Static analysis of the public AUTORIZADOR target from issue #2926 used
  SHA-256 `1398d55a71a9e4ac04f7a12f5f1bec9d0b4343fbd1c0f8635938d261f18fa363`
  and one function seed at `0x535300`. The program was never executed.
  Address `0x5355eb` now resolves to `0x535300`; the body is
  `0x535300..0x5356be`, with handler string references at `0x5355f8` and
  `0x535643`. Handler `0x5356bf` remains outside that span and explicitly
  limits callee coverage to partial. This is bounded recovery, not a claim
  that all Delphi exception patterns are resolved.
- `docs:check` is blocked by unchanged Greek README link drift tracked in
  https://github.com/morluto/rea/issues/3022.
- Full package verification passed, including the shipped Java helper,
  archive/install, CLI, MCP, setup/uninstall and verified empty process lineage.
