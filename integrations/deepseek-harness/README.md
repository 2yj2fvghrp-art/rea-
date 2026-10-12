# REA for DeepSeek Harness

A native **installable Harness bundle** exposing REA's existing local MCP server
as `mcp__rea__*` tools, using the current `dsh.bundle`/Cordis composition API.
The full REA engine remains authoritative; this adapter has no second reverse-
engineering engine or parallel tool schema to keep synchronized.

## Requirements

- A DeepSeek Harness installation with the `dsh` CLI and `pnpm` on `PATH`.
- Node.js accepted by REA: `^22.19.0 || ^24.11.0 || >=26.0.0`.
- Optional analysis engines (Ghidra, IDA, JADX, etc.) remain **bring-your-own**.
- Permission to run locally installed code and to analyze the chosen target.

## Install the bundle from this repository

The installable package is in `integrations/deepseek-harness`, **not** the
root REA CLI package:

```sh
dsh plugin --profile web add 'github:xxxxxwater/rea#path:integrations/deepseek-harness'
dsh --profile web --dump-config
dsh --profile web
```

Pin an audited commit for a reproducible installation:

```sh
dsh plugin --profile web add 'github:xxxxxwater/rea#<COMMIT_SHA>&path:integrations/deepseek-harness'
```

Alternatively install a local checkout:

```sh
dsh plugin --profile web add /absolute/path/to/rea/integrations/deepseek-harness
```

The bundle ships build-free JavaScript. Its default server is the **upstream
prebuilt** `rea-agents@6.4.0` npm dependency. Installing it does not build
the complete REA source checkout or install Ghidra/IDA. A Git-source install
of this small bundle therefore requires no build script allowance.

### Run this fork's REA implementation

To run the code checked out from **xxxxxwater/rea** rather than upstream npm:

```sh
cd /absolute/path/to/rea
npm ci
npm run build:cached
export REA_DSH_ENTRYPOINT="$(pwd)/scripts/rea.mjs"
dsh --profile web
```

The environment variable must be an **absolute path** to an existing
`scripts/rea.mjs`. The plugin starts it with the Harness host's active
Node executable (`process.execPath`) and argument `mcp`, without `npx`,
shell interpolation, implicit upgrades, or downloads. A missing local
`dist/mcp/main.js` makes REA fail closed with its build instructions.

**Desktop users:** install into the active Desktop plugin profile through
the application/plugin manager, and ensure host-level overrides reach the
Desktop process. Do not assume Desktop runs CLI `--profile web`. In the
latest Harness CLI, `desktop` is a reserved profile name, not a normal
`dsh --profile desktop` target.

## Architecture and behavior

Two plugin rows are contributed to Harness composition:

1. `rea-launcher` provides the scoped Cordis `reaLauncher` service.
2. `rea-mcp` injects that service into the built-in
   `@deepseek-ai/dsh-mcp-client` over local `stdio`, which registers
   tools under `mcp__rea__<tool_name>` and handles disposal/reconnection.

By default the bundle sets `REA_DSH_SCHEMA_PROFILE=compact`. This reduces
model-facing schema bytes; REA still validates canonical full inputs. Set
`REA_DSH_SCHEMA_PROFILE=full` in the Harness host environment to advertise
full tool schemas. Unsupported values fail startup. Tool calls have a
120-second deadline. To tune this, use a later profile-owned Cordis patch
that restates the full `rea-mcp` config.

Example Harness prompt:

> Use REA to analyze the JavaScript application at /absolute/path/app.js;
> identify observations, derivations, and unresolved unknowns with evidence.

REA's local security and authority constraints still apply. Installing the
bundle does not authorize injection, process mutation, privileged operations,
or a target you are not permitted to analyze.

## Migrating from `rea setup --client dsh`

The legacy CLI setup places a `rea-mcp` row in
`$DSH_HOME/cordis.patch.yml`. **Home patch layers win over bundle layers**.
Back up that file, then remove only its legacy `rea-mcp` insertion, preserving
all unrelated configuration. Restart Harness. Keeping the same row ID avoids
creating a second default `rea` MCP namespace, but the legacy row will hide
this bundle until removed.

## Check installation and uninstall

```sh
dsh --profile web --dump-config
dsh plugin --profile web remove dsh-rea-bundle
```

The dump should identify the `dsh-rea-bundle` layer, `rea-launcher`
and `rea-mcp`. If it identifies a home-patch override, migrate as above.
If it says the launcher is missing, check the npm dependency or local
`REA_DSH_ENTRYPOINT`. If REA says `dist/mcp/main.js` is missing, build
the fork checkout. Check target-engine prerequisites separately.

## Tests and verification scope

```sh
node --test integrations/deepseek-harness/tests/*.test.mjs
node integrations/deepseek-harness/scripts/verify-package.mjs
```

GitHub Actions also checks npm pack contents, real packaged REA MCP
initialization/tool discovery, and latest-upstream Harness bundle composition.
A successful config dump alone does **not** establish a live DeepSeek model
API call, a Desktop GUI integration, or access to optional Ghidra/IDA/JEB.
These require separate end-to-end acceptance on the target system.
