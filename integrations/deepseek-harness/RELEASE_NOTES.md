# REA for DeepSeek Harness — plugin bundle v0.1.0

First standalone DeepSeek Harness plugin bundle for this repository.

## Included

- Native `dsh.bundle` Cordis package for Harness plugin profiles.
- REA MCP integration through the built-in `@deepseek-ai/dsh-mcp-client` bridge.
- Build-free runtime launcher that resolves a pinned prebuilt
  `rea-agents@6.4.0` npm package without shell/npm execution at startup.
- Optional `REA_DSH_ENTRYPOINT` absolute-path override for this fork's
  compiled `scripts/rea.mjs` instead of the upstream npm runtime.
- `compact` or `full` advertised MCP schema profile, fail-closed startup,
  scoped process environment, and Harness-owned reconnect/disposal.
- Automated tests for manifest, launcher, MCP initialization/tool listing,
  and current upstream Harness bundle composition.

## Install

Download the attached `dsh-rea-bundle-0.1.0.tgz` and run:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-rea-bundle-0.1.0.tgz
dsh --profile web --dump-config
```

The recommended installation is the published release tarball above; install
the repository subdirectory from a **local checkout** only after installing
its plugin dependencies. See the plugin guide for that development path.

macOS/Linux users can also download and verify the artifact directly:

```sh
curl -fL -o dsh-rea-bundle-0.1.0.tgz https://github.com/xxxxxwater/rea/releases/download/dsh-v0.1.0/dsh-rea-bundle-0.1.0.tgz
printf '%s  %s\n' '03a525a9b266bb4b43ae7c92b79b7a9752b0414bf338edb025ee1ce8e3c6500e' 'dsh-rea-bundle-0.1.0.tgz' | shasum -a 256 -c -
dsh plugin --profile web add ./dsh-rea-bundle-0.1.0.tgz
```

Read the [plugin guide](https://github.com/xxxxxwater/rea/blob/main/integrations/deepseek-harness/README.md)
for Desktop environment/profile semantics, migrating a legacy home-level
`rea-mcp` patch, and using this fork's locally compiled REA runtime.

## Scope

This `dsh-v*` GitHub release distributes **only the Harness plugin bundle**.
It does not change or publish the root `rea-agents` npm package or MCP
Registry package; those use the repository's separate, reviewed Release Please
workflow. Live DeepSeek paid-model calls and optional third-party engines
remain outside CI acceptance.
