<div align="center">

# REL

### Reverse Engineering Life

**Understand how software works. Keep the evidence. Learn by doing.**

A beginner-friendly investigation interface built on top of [REA — Reverse Engineer Anything](https://github.com/morluto/rea).

**[Get started](#first-run-in-a-terminal) · [Use with Codex](#use-rel-with-codex-or-another-ai-agent) · [Supported targets](#what-can-rel-investigate) · [Original REA documentation](UPSTREAM_REA_README.md)**

</div>

---

## What is REL?

REL is **not an AI model and not a replacement for the underlying reverse-engineering engines**. Think of it as the workbench that connects them.

| Piece | Job |
| --- | --- |
| **You** | Ask a question: “How does this feature work?” |
| **REL Simple Mode** (`rel.mjs`) | Recognize the target, show the applicable workflow and its limits |
| **REA** (`scripts/rea.mjs`) | Inspect local software, create graphs, trace evidence and expose MCP tools |
| **Codex or another AI agent** | Interpret the evidence and explain it in ordinary language |
| **Optional native tools** | Supply deeper binary analysis when available (Hopper, Ghidra, IDA, etc.) |

**It has both a terminal interface and an AI interface.** The same REA engine can answer direct CLI commands or be called by an MCP-capable agent. The REL-branded shortcut is still being developed.

### What actually works today?

- **Works:** `node rel.mjs types`, `node rel.mjs inspect TARGET`, `node rel.mjs demo` — safe target identification and preview.
- **Verified:** `node rel.mjs demo --run --out DIR` builds on our source-owned example to invoke the *real*, locally built REA JavaScript analyzer, save full Evidence, and generate a smaller readable report after the build.
- **Existing upstream capability:** Advanced REA CLI and MCP workflows for JavaScript/Electron, native binaries, managed code, app packages, websites, captured traffic and more. Many require additional dependencies or authority.
- **Not yet built into REL Simple Mode:** Arbitrary-target `--run`, an interactive REL dashboard, a one-command natural-language agent, automatic reconstruction, or a guaranteed “reverse engineer anything” result.

A previous real-engine check on our own lab produced **43 application graph nodes and 65 relationships**. See [the recorded proof](experiments/rel-first-lab/VERIFIED_RESULTS.md). That is a successful *small-sample* test, not a universal capability claim.

## First run in a terminal

These commands are for macOS/Linux terminals. Windows users can use an appropriately configured Node terminal and choose a platform-specific output directory.

**1. Clone the actual REL work-in-progress branch** (until the draft PR is merged):

```sh
git clone --branch rel/first-lab-foundations --single-branch https://github.com/gryszzz/Reverse-Engineering-Life-REL-.git
cd Reverse-Engineering-Life-REL-
```

**2. See the interface.** For these preview commands, you need Node.js but not the REA build:

```sh
node rel.mjs
node rel.mjs types
node rel.mjs demo
node rel.mjs inspect "$PWD/experiments/rel-first-lab" --question "What is in this application?"
```

`inspect` is **preview-only**. It does not run the target or contact a supplied website.

**3. Prove real analysis on our own demo.** Install the pinned Node version from `.nvmrc` (currently Node 24.18.0) and use the repo's npm lockfile. If you already have nvm, run `nvm use` after installing that version.

```sh
npm ci
npm run build:cached
OUT="$(mktemp -d)"
node rel.mjs demo --run --out "$OUT"
cat "$OUT/REL_EVIDENCE_REPORT.md"
```

The runner saves the complete `evidence.json`, REA's `view-evidence.json`, a `summary.json` and a readable report **outside the repository**. It does not analyze any other project.

**4. Use the full upstream REA CLI from the fork** when you need a supported advanced operation:

```sh
node scripts/rea.mjs --help
node scripts/rea.mjs providers --json
node scripts/rea.mjs capabilities --json
```

These commands run the **local fork**. In contrast, `npx rea-agents` downloads/runs the *published upstream REA package*, which does **not** contain our REL changes.

## Use REL with Codex or another AI agent

**Yes—Codex can use the underlying REA tools through MCP.** It can also read the code and this repository's `AGENTS.md` when the local checkout is open as its workspace. Those are different things:

- **Repository context** tells Codex what REL is, what commands exist and how we work. It is *not* new model training.
- **MCP registration** gives Codex a tool connection to the locally built REA server, which exposes more than the simple `rel.mjs` preview.
- **A prompt** tells Codex your investigation question and the allowed target. Without a working checkout/connection, it cannot inspect arbitrary files on your machine.

### The basic connection (optional; you choose when to run it)

After `npm ci` and `npm run build:cached`, from the REL checkout:

```sh
codex mcp add rel -- node "$PWD/scripts/rea.mjs" mcp
codex mcp list
```

Then restart your Codex session/extension, open the **REL repo workspace**, and check `/mcp` in the Codex terminal interface to see the connected server.

This **changes your local Codex MCP configuration**, so it is an *optional step you run yourself*. We have **not** registered REL on your machine or checked your personal Codex environment. MCP exposes REA's **full** tool catalog: before using runtime tools on real software, review target permissions, resource requirements and possible side effects.

For a reversible, project-aware configuration, exact path guidance, test prompts and troubleshooting, read **[CONNECT_CODEX.md](rel/CONNECT_CODEX.md)**. The Codex MCP command format is documented by [OpenAI](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

**Try asking Codex, while working in this fork:**

> Read REL's README and AGENTS.md. Only investigate the REL first-lab directory. Use read-only REA JavaScript analysis to show the imports between `cli.mjs`, `notes.mjs` and `search.mjs`. Cite exact source locations, tell me what you inferred, and clearly label what you could not verify. Do not edit another repository, execute an unknown target, or configure external services.

### If you're using ChatGPT on your phone

This GitHub fork and your local Codex/MCP connection are **not automatically the same connection**. Here we can work on your GitHub repo through its connection, but that alone doesn't start the REL program on your Mac or expose its local files. To execute the local MCP server, use a Codex/desktop environment with access to the built checkout.

## What can REL investigate?

The REA base supports multiple families; **capability depends on your target and installed tools**:

| Target | Typical investigation | Requirements / caveat |
| --- | --- | --- |
| JavaScript / Electron | Modules, imports, processes, IPC, source maps | Node.js; static mode available |
| Native executables and libraries | Assembly, pseudocode, symbols, calls | Compatible Ghidra, Hopper or IDA |
| .NET | Assembly metadata, methods and CIL | Confirm the file is actually managed |
| Websites | Scripts, page structure and observable requests | Browser, authorization, runtime side-effect review |
| APKs and Apple packages | Manifests, resources, code and native boundaries | Extra platform-specific tooling |
| WASM | Imports, exports, sections and decoded content | WABT for deeper parsing |
| SQLite | Schema and selected sample rows | Snapshot; compatible Node version |
| HAR / PCAP | Previously captured network behavior | Supported capture format and tools |
| Firmware / raw binaries | Identify regions or hand off to a native provider | Format/architecture knowledge; extra tools |

Run `node rel.mjs types` to see what the simple interface can classify. *Recognition alone is not proof that the analysis engine for that format is installed.*

## How we investigate

```text
Question → Identify target → Check authority and readiness
         → Choose REA workflow → Produce full Evidence
         → Explain important findings → State unknowns
         → Verify with a controlled test → Only then consider reconstruction
```

The goal is not to dump 100,000 lines of internals into a chatbot. REL should retain complete source evidence while showing you a **short answer, the exact supporting locations, confidence/coverage and what to check next**. Static code relationships do not alone prove runtime execution; a reconstructed feature is a new implementation to test, not magically recovered original source.

### Planned interface (not implemented yet)

Four human actions: **Understand**, **Map**, **Compare**, **Reconstruct**. These are the design direction for a future agent-centered REL interface. We will add them incrementally after verifying each workflow against authorized, reproducible fixtures.

## Repository guide

| Location | Purpose |
| --- | --- |
| [`rel.mjs`](rel.mjs) | Beginner terminal entry point |
| [`rel/intake.mjs`](rel/intake.mjs) | Read-only target classification |
| [`rel/CONNECT_CODEX.md`](rel/CONNECT_CODEX.md) | Optional Codex/MCP setup |
| [`experiments/rel-first-lab/`](experiments/rel-first-lab/) | Safe demo and saved verification |
| [`REL_START_HERE.md`](REL_START_HERE.md) | Learning milestones |
| [`src/`](src/) | Original REA analysis machinery |
| [`docs/cli.md`](docs/cli.md) / [`docs/installation.md`](docs/installation.md) | Advanced CLI and setup |
| [`UPSTREAM_REA_README.md`](UPSTREAM_REA_README.md) | Preserved upstream landing page and docs links |

## Project boundaries and attribution

REL is a fork-specific learning and usability layer. **At this stage we are changing only this REL repository**, not integrating your other projects. Run investigations only on targets you own or are authorized to inspect. The `rel.mjs` shortcut is preview-only for arbitrary targets; directly connecting the underlying MCP is a separate, potentially more powerful tool connection.

Based on **[morluto/rea](https://github.com/morluto/rea)**. Original README preserved in [`UPSTREAM_REA_README.md`](UPSTREAM_REA_README.md); original [MIT license](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md), and upstream technical docs remain available. This fork isn't affiliated with or published as the original REA npm package.
