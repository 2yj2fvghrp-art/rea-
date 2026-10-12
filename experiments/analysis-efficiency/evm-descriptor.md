# EVM descriptor and real-template checkpoint

Continues [#2016](https://github.com/morluto/rea/issues/2016) after the native
checkpoint merged. The next internal descriptor will bind the existing exact EVM
contract, CLI name and typed service lifetime. Existing complete inputs, output,
provider selection and cleanup remain the baseline. Wiring alone does not establish
token or latency savings.

## Public inputs and independent checks

[corpus.json](corpus.json) retains the original WETH historical example and adds
Uniswap v3-core 1.0.1 Factory/Pool compiler runtime templates from the official npm
package. Archive integrity, exact regular member, compiler JSON, original carrier
and decoded-byte digests are pinned. The carrier is the original `deployedBytecode`
field plus one trailing LF. No placeholder is rewritten and no contract is executed.

These are compiler templates, not live deployed instances. Their published Hardhat
artifacts omit immutable-reference maps; that metadata remains explicitly unknown.
The recorded empty link-reference maps do not establish absence of immutables.
WETH remains a published historical RPC example, with unknown live authenticity.

Actual control CLI observations infer 7 Factory and 26 Pool functions. The
[independent verifier](verify-evm-template.mjs) hashes each canonical published ABI
signature with caller-supplied Ethereum Keccak and checks the complete ABI-dispatch
selector multiset against the original REA response. Both sets match. This does not
establish inferred argument/mutability equivalence, deployment authenticity or
runtime semantics; all producer unknowns remain visible.

## Latest-main control

Production control: `1770f38cfc6cbe87491d0de8b8730c305c5cf8ea`, Node 24.18.0,
npm 11.16.0, matching locked dependencies and unchanged EVMole 0.9.3.
The frozen `dist/`/`bridge/` file-table SHA-256 is
`7fd6c2c37b4e166df158ec29d48d31f3712b9b087d9807ee019ee997d06ea144`.
Measurement driver SHA-256 is
`f767c0c0232be1e11918e70e3197a6919680d16688076bef28d4320662f712f7`.
Each public SDK run validates the selected named advertised schema and verifies
original carrier and decoded identities, inference/unknown scope and unchanged
input bytes. All three runs return the same complete 2,420,709-byte catalog.

| Question                 | Inferred functions | SDK tool-result JSON bytes | First workflow seconds |
| ------------------------ | -----------------: | -------------------------: | ---------------------: |
| WETH historical carrier  |                 11 |                     26,760 |                 11.432 |
| Uniswap Factory template |                  7 |                    110,424 |                  3.628 |
| Uniswap Pool template    |                 26 |                    110,998 |                 11.211 |

These are initial observations, not paired performance conclusions or model-token
counts. Each workflow includes connection, complete catalog discovery and one
interface query. Full bytecode remains inline. Candidate/control repetitions must
use the same source driver, inputs, provider settings and Node/worker limits.

Preparation against earlier frozen main `b1bf4a70d44191348ca20a91a52fb663da4daed0`
also passed all 59 cases of the existing real CLI/MCP EVM verifier with privately
supplied solc 0.8.30 and strace 6.1. Those cases cover compiler configurations,
raw/hex identity, malformed/unsupported carriers, missing limiter and resource
constraints. Its measured scope took 233.1 seconds, sampled peak 1,192,730,624
bytes and last-observed CPU 181.018 seconds. This is a control, not candidate proof.

All heavy runs are serial under one CPU, 4 GiB hard memory/3 GiB early-stop, no swap
and bounded tasks. Final cgroup counters disappear at scope teardown and remain
unverified; last-observed zero limit events are not substituted for final counters.
Raw replies, tools, compiler artifacts and detailed receipts remain outside Git.

## Reproduction

Build and freeze each pinned runtime using the repository toolchain, then run
`measure.mjs --artifact uniswap-v3.factory.hex` or `uniswap-v3.pool.hex` with the
exact derived carrier, `--schemas selected`, explicit runtime/revision and a fresh
private output directory. Existing `weth.hex` answer fields and invocation remain
unchanged. The same common workflow verifies all three offline carriers.

Run `verify-evm-template.mjs` with `--artifact` selecting the corpus ID,
`--artifact-json` selecting its original published compiler JSON, `--evidence`
selecting the recorded CLI Evidence or SDK structured reply, `--keccak-module`
selecting the absolute `js-sha3/src/sha3.js` module from the private solc toolchain,
and `--output` selecting a new private receipt. It acquires no dependencies and
does not overwrite an existing receipt.

The [template model question](questions/evm-uniswap.txt) requires the same complete
inferred interface facts and explicit unknowns. Real model trials and a candidate
recommendation are pending; an ABI-count match is not used as a model grade.
