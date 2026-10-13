# Implementation plan

1. Validate JSON call records, IDs and conflicting options at the CLI boundary.
2. Lazily compose one production session and MCP server. Connect an SDK client
   through InMemoryTransport, so canonical registration, parsing, execution,
   Evidence delivery and cancellation remain identical to MCP.
3. Await each call and output write before advancing. Keep only the current
   result. Use canonical JSON serialization with backpressure; file outputs use
   exclusive creation and safe filenames. Do not return a second CLI document.
4. In finally, settle SDK server work and close server, client, optional
   observation resources and BinarySession; project typed cleanup failures.
5. Cover compiled CLI file/stdin calls, shared native sessions with real Ghidra,
   errors, duplicate/path IDs, stop/continue, output collisions and cancellation.
   Measure equivalent multi-query sessions; distinguish synthetic timing from
   real-provider costs. Run static, discovery and documentation checks.
