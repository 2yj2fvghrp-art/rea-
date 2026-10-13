# REL — Start here

**REL is our learning workspace built around the upstream [REA (Reverse Engineer Anything)](https://github.com/morluto/rea).** This is a fork-specific on-ramp, not a claim that we have rewritten the engine. Preserve upstream attribution, LICENSE, and THIRD_PARTY_NOTICES.md.

## Goal

Learn to answer a narrow question about authorized software with **evidence**, then test the explanation. Our first milestone is a repeatable, understandable **local investigation**, not a new agent or native-analysis provider.

~~~text
Question → choose authorized target → observe behavior → inspect structure
         → separate facts from guesses → verify → record what remains unknown
~~~

REA provides a CLI and an MCP server for agents. Both use shared analysis workflows. In this fork, the CLI entry point is scripts/rea.mjs, with routing in src/cli.ts and implementations in src/. The published npm package rea-agents is upstream; **npx rea-agents does not automatically run code from our modified fork**. Build and run the local entry point when testing fork changes.

## Start with the offline REL First Lab

Visit [experiments/rel-first-lab/README.md](experiments/rel-first-lab/README.md). Its five fictional notes and search command are entirely contained in this fork. No API keys, websites, other projects, browsers, Hopper, Ghidra, or IDA required.

From the repository root:

~~~bash
node experiments/rel-first-lab/cli.mjs bridge
node experiments/rel-first-lab/verify.mjs
~~~

Expected search order: **Bridge Patterns → Signal Bridge → Local Cache**. First predict *why*. Then open search.mjs and compare your prediction with the actual code. The verifier checks only this toy example; it does **not** prove the complete REA analyzer works.

## Code map

| Path | What it does |
| --- | --- |
| scripts/rea.mjs and src/cli.ts | Start and route CLI commands |
| src/main.ts and src/server/ | MCP/server entry points |
| src/composition/ | Wire providers and workflows |
| src/application/ and src/javascript/ | App-analysis and JavaScript logic |
| src/domain/ and src/contracts/ | Evidence models, types, contracts |
| docs/cli.md | CLI usage and summary views |
| docs/javascript-application-workflows.md | Graph, trace, and comparison semantics |
| experiments/rel-first-lab/ | Our source-owned practice target |

Static relationships are **inferences, not proof of execution**. Observations, derivations, confidence, unknowns and coverage are intentionally separate in REA. See [JavaScript Application Graph](docs/javascript-application-graph.md).

## Our improvement loop

1. **Learn:** run the lab CLI, verify the output, inspect imports and ranking.
2. **Use:** optionally build the local fork and run static analysis on the lab folder only.
3. **Record:** fill in [the worksheet](experiments/rel-first-lab/WORKSHEET.md) with an exact command, facts, inferences, unknowns, and a test.
4. **Measure:** capture runtime, Evidence size, extra commands, and whether the question got answered.
5. **Improve one bottleneck:** if evidence is hard to read, prototype a small REL summary/report rather than rebuilding the full engine.

## Scope and safety

- **Only this REL fork** is in scope. Do not integrate it with any of our other repositories or services.
- Use only software and targets we own or are authorized to inspect.
- Prefer static, read-only work. Runtime execution, process attachment, debugger actions, and browser interactions need separate review.
- Do not run global setup, change agent configurations, install native providers, publish packages, or launch unknown programs for this first lab.
- Keep changes on a separate branch; preserve the original engine while learning.

**Milestone 1 is complete only when** the demo works, the explanation is reproducible, and any full REA analyzer run is truthfully labeled verified or unverified. No broader reconstruction-accuracy claims.
