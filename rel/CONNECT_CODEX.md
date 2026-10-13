# Connect REL to Codex

REL has two distinct interfaces. The beginner CLI (`node rel.mjs`) previews arbitrary target families and can analyze an explicitly authorized JavaScript/Electron directory or ASAR statically. The existing REA MCP server (`node scripts/rea.mjs mcp`) exposes the engine's _full_ toolset to a capable agent.

**This document is a guide, not a claim that your machine or personal Codex session has been configured.** All steps below are optional and affect only the environment where you run them. Current development work remains limited to this REL repository.

## Step 1 — clone and build the actual fork

From a macOS/Linux terminal, while the work is on a draft branch:

```sh
git clone --branch rel/first-lab-foundations --single-branch https://github.com/gryszzz/Reverse-Engineering-Life-REL-.git
cd Reverse-Engineering-Life-REL-
```

Use the Node version in `.nvmrc` (24.18.0 at the time of this guide) and matching npm toolchain. With nvm already installed, run `nvm install` and `nvm use`. Then:

```sh
npm ci
npm run build:cached
node rel.mjs demo
OUT="$(mktemp -d)"
node rel.mjs demo --run --out "$OUT"
cat "$OUT/REL_EVIDENCE_REPORT.md"
```

Do **not** use `npx rea-agents setup` here if your goal is testing our fork: `npx rea-agents` uses the published upstream package.

## Step 2 — choose how Codex gets involved

### Option A: Codex works in the repository (no MCP installation)

Open the REL checkout as your Codex workspace, and ask it to read `README.md` and `AGENTS.md`. It can explain source and—if its environment allows shell commands—run the included `node rel.mjs` commands. This does not mean it is permanently retrained on our project.

Start with:

> Explain the REL codebase to me in plain English. Stay within this REL fork. Start with `node rel.mjs types` and `node rel.mjs demo`. Identify the supported functions, what is preview-only and which deeper REA tools require installation or permission. Do not make changes.

### Option B: use our committed project-scoped Codex MCP entry (preferred)

We have committed `../.codex/config.toml` and the `../.agents/skills/rel-investigator/SKILL.md` skill **inside this REL fork**. This is a repository change, not a mutation of your personal Codex installation. Codex reads project-scoped configuration only for trusted workspaces.

From the checkout root, after installing dependencies and building:

```sh
node rel.mjs codex
codex mcp list
```

Open or restart Codex **from the REL repo root**. Check `/mcp` and look for `rel_rea`. Try `$rel-investigator` to load the project skill. The Codex CLI/IDE needs to have the checkout available locally; a remote/cloud Codex instance needs its own copy and build.

Our project's MCP server runs `node scripts/rea.mjs mcp` with `cwd = "."`. It exposes the **full** underlying REA tool catalog, including potentially side-effecting capabilities when available. Keep Codex approvals active and restrict work to your stated authorized target. `node rel.mjs analyze TARGET --authorized --out NEW_DIR` provides a separately gated static-only JavaScript path.

If you choose to register a global server for other workspaces instead, the optional command remains:

```sh
codex mcp add rel -- node "$PWD/scripts/rea.mjs" mcp
```

But **do not do that for this fork by default**; project configuration already handles our trusted REL workspace. A global entry can create duplicate tools or expose powerful tools in unintended workspaces. No such global registration was performed here.

## Step 3 — ask the AI a scoped question

After confirming the MCP server is registered and available, try:

> We're working only in the REL fork. Investigate `experiments/rel-first-lab/` using REA's static JavaScript analysis. Which modules import which? Find precise source lines for the two imports from `cli.mjs`. Explain the result to someone new to reverse engineering. Distinguish static inferences from observed runtime behavior. Do not analyze other folders, install extra tools or change any files.

To learn the difference between coding knowledge and actual analysis:

> Explain the difference between what you learned by reading the three source files, what REA's static graph says, and what the search program actually printed. Show the evidence for each and state one unknown that remains.

For another _authorized_ target later, explicitly provide its path, your specific question, and what kinds of static or runtime inspection you approve. Never treat a general request as approval to browse a live website or run an unknown binary.

## Step 4 — diagnose or remove

If `/mcp` doesn't show REL, check the runtime has been built with `npm run build:cached`, ensure the path points to the checkout (not the published npm package), verify `node` is on Codex's process PATH, and restart Codex. The server may fail if the work is running on another computer/host without access to the local files.

To remove **only** this manually added MCP server from Codex:

```sh
codex mcp remove rel
```

This removes the named Codex registration, **not** the repository. If you already had an `rea` registration from upstream, it is separate from our `rel` name. You can retain it or disable it yourself to avoid duplicate tool sets.

## ChatGPT phone vs Codex

A ChatGPT conversation with GitHub access can inspect and modify repo files, but that **does not** automatically install a running local REA server or grant access to your Mac. A local Codex CLI/IDE session with a built checkout can make use of local stdio MCP. Remote Codex/cloud sessions need their **own** supported runtime or access to a remote MCP endpoint; a Mac-only path will not automatically exist remotely.

Sources: [OpenAI MCP setup guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [upstream REA installation and setup](../docs/installation.md), [REA CLI](../docs/cli.md).

## Where we're going

A future REL action such as **Understand** should ask for a target and question, check tool availability and permission, execute a supported analysis, then return a bounded plain-English finding and retained Evidence. **That one-prompt workflow is not automatically implemented by `rel.mjs` yet.** Codex + REA MCP is our first practical AI-driven workflow while we build the simplified orchestration.
