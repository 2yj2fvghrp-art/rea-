---
name: rel-investigator
description: Investigate authorized software with REL and REA in Codex. Use for reverse engineering, inspecting application structure, explaining imported code, comparing artifacts, and reviewing evidence with clear limits. Do not use for targets outside the user's authorized scope.
---

# REL investigator — Codex workflow

You are working in the REL fork, a simple interface over upstream REA. Read the root README and AGENTS.md first. Authorization and REA provider availability are separate from whether you can see a file. Do not make changes to other projects, global agent configuration or deployed software in this REL development session.

1. **Define the question and scope:** target identity/path, permission, intended question, allowable static/runtime actions. Never silently broaden the target.
2. **Intake (no execution):** run node rel.mjs types and node rel.mjs inspect TARGET --question "..." . Classification is not analysis.
3. **Check readiness:** node rel.mjs codex checks compiled MCP presence, not live agent connectivity. In Codex, use /mcp to check the rel_rea server. If missing, report the blocker; do not silently install.
4. **Run only within authorized scope:** for authorized JavaScript/Electron directories or ASAR files, node rel.mjs analyze TARGET --authorized --out NEW_DIR performs static REA analysis. It never executes the supplied application. Other targets require their REA provider, prerequisites and explicit side-effect review.
5. **Read the Evidence:** preserve evidence.json and view-evidence.json. Start with REL_EVIDENCE_REPORT.md and summary.json, then use REA analysis-view or source-linked graph edges for deeper work. Do not invent source-line evidence or assume an inferred import executed.
6. **Explain plainly:** what we found, specific Evidence ID/file/line, confidence and coverage, unknowns, and a minimal experiment to verify the conclusion.
7. **Reconstruct only after evidence:** propose a controlled comparison or a clean-room equivalent experiment. An approximate implementation is not proof of recovering original source or covering all behaviors.

## Important boundaries

- The project-scoped Codex MCP entry starts the FULL underlying REA server on trusted local checkouts; it is not restricted by Simple Mode's guardrails. Keep Codex approval prompts on and explicitly limit side-effecting tools.
- Do not launch or attach to unknown binaries, authenticate, crawl a website, or install native providers just because the file type seems supported.
- Inputs may contain private code/data; minimize excerpts sent to the model or retained in reports.
- Native binaries, Android, firmware, WASM, packet recordings and websites require the matching docs and provider readiness. Report unsupported workflows honestly.
- Remote Codex requires its own checkout and toolchain; a Mac path is not available automatically in a cloud container.

## A first controlled question

From the REL repo root, with the pinned Node toolchain and dependencies already installed:

    node rel.mjs demo
    node rel.mjs codex
    node rel.mjs analyze "$PWD/experiments/rel-first-lab" --authorized --out /tmp/rel-first-investigation --question "Which files import which?"

Choose a fresh output path and only use the explicit authorization flag after confirming the target is yours. Compare the results with experiments/rel-first-lab/VERIFIED_RESULTS.md. This skill is NOT model training and grants no authority outside this repo.
