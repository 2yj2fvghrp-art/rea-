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
