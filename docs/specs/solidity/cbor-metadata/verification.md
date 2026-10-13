# Verification

After integrating upstream 82cfcee19f18b0eeae9a330ba04e0411cdf85225, 45 tests passed
across the parser, domain contract, application service, compiled worker and MCP
boundary (five files). Compiled-worker goldens include BOM text, partial nested
values and unavailable trailers. All six static tasks and architecture guards
passed. Before integration, test discovery found all 984 files exactly once.

The parser regressions cover exact large integers and typed keys, malformed UTF-8,
duplicate keys, excessive nesting, unsupported tags/floats, length bounds and
historical omission. A real defect in the decoder's default text handling removed
an initial U+FEFF. The owning tokenizer now validates and decodes the retained
text bytes with BOM preservation; independent fixtures check both values and
compiler-key identity.

The owned fixture was compiled with caller-selected solc 0.8.30, using unoptimized,
optimized via-IR, content-hash-free and CBOR-free settings. All four metadata
checks passed again after integration. No contract was executed. Local first decode
took approximately 0.81 ms or less; 100 warm parses took approximately 2.92 ms or
less. These figures
describe these fixtures and this host, not a general workload. Peak process RSS
included the compiler (299536 KiB); complete process-family CPU/memory and agent
token costs were not measured.

Compiled worker tests exercise unchanged EVMole WASM on this macOS host. MCP tests
use the production server and contracts with an injected provider seam. The full
Linux-only provider CLI/MCP, resource-limit and cleanup lane remains unverified
here. Metadata JSON commitment binding remains deferred under issue #2388.
