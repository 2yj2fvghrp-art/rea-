# Authorized security research with REA

REA can inspect a local application artifact and return Evidence for a security
investigation. Run `rea-research-ui` from a package containing this feature, or
`npm run research:ui` from a source checkout, then open its printed loopback
URL to fill a local browser case. The UI exports
JSON, Markdown, and a policy-text snapshot; it does not fetch a program page or
run analysis. You can also copy the [blank case template](authorized-security-research-case.md)
to a directory outside the REA checkout. Fill it with the program's exact rules,
target identity, and artifact identity before drawing conclusions or testing a
running target.

## What to collect

| Input       | Record                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program     | Program name, platform, URL, participation status and check time, report channel, and disclosure rules.                                                                |
| Policy      | Source URL, time captured, an exact saved copy of the applicable policy and scope text, and its SHA-256 digest. Record later policy changes as another snapshot.       |
| Scope       | Exact in-scope app identifiers, versions, domains or API origins where named, and explicit exclusions. An app-store listing or a brand name does not establish scope.  |
| Test rules  | Allowed and prohibited techniques, rate or time limits, account and test-data requirements, privacy rules, and disclosure requirements. Mark missing rules as unknown. |
| Artifact    | Local absolute path, acquisition source, platform, package or bundle identifier, version/build, and SHA-256 digest. Record each version separately.                    |
| Environment | Owned device or test account, OS version, relevant dependencies, and whether running the app can reach a live service.                                                 |

A program URL is a pointer to the policy, not a grant to test every asset linked
from that page. The saved policy copy is a reviewable record of what was read;
it does not authorize a later action if the program, participation state, or
scope has changed. Check the current policy and participation state before
interacting with a live target. When either is unclear, continue with local
artifact inspection and leave live behavior unknown.

For a local file, calculate its digest with `shasum -a 256 /absolute/path/to/file`
on macOS, `sha256sum /absolute/path/to/file` on Linux, or
`Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\path\to\file'` in PowerShell.
Keep the original
download or acquisition URL as provenance, and preserve the exact path used by
REA. Do not replace those values with a display name.

## Investigate the artifact

Use the command that matches the supplied artifact and the question. Save the
JSON result with the case so its Evidence, limitations, and unknowns remain
available. Each CLI invocation is a separate process; MCP retains Evidence
within its session and can export a bundle. See [CLI and Evidence](cli.md#import-export-and-compare-evidence)
for export and comparison commands.

- **Android APK:** `rea inspect-android-package /absolute/path/to/app.apk --json`
  decodes package declarations and manifest text without launching the app.
  Bring your own JADX and Java for code inspection; see
  [Android analysis](android-analysis.md). Treat exported-component or trust
  boundary concerns as candidates until their effective behavior is verified.
- **iOS IPA or Apple app bundle:** `rea inspect-artifact /absolute/path/to/app.ipa --json`
  inventories a package. Follow relevant files with the
  [Apple application guide](apple-application-analysis.md) and a configured
  native provider where supported. Package inspection is not iOS device
  observation.
- **Electron or JavaScript app:** `rea analyze /absolute/path/to/app --json`
  builds a static application graph for an extracted tree or ASAR; see
  [JavaScript reconstruction](javascript-artifact-reconstruction.md).
- **Native desktop executable:** `rea analyze /absolute/path/to/program --provider ghidra --json`
  uses an installed, configured provider where that target is supported. See
  [native analysis](native-investigation.md) and the
  [Windows P0 boundary](windows-ghidra-p0.md). The command does not establish
  support for every platform, architecture, or file format.

Launching an application or using browser, Electron, network, or process
capture can contact real services. REA's process and Electron capture are not
security sandboxes. Choose an owned environment and actions permitted by the
current program rules, and keep those runtime observations separate from
static findings. See [process capture](process-capture.md) and
[Electron observation](electron-observation.md) for effects and limitations.

## Turn evidence into a report candidate

For each candidate, record the entry point, relevant check or missing check,
and affected operation or privileged sink. Cite the exact REA Evidence ID and
source location, the policy snapshot digest, and the artifact digest. Separate:

- **Observation:** what the artifact or an authorized test actually showed;
- **Inference:** a possible exploit path and competing explanations;
- **Unknown:** untested behavior, incomplete coverage, or uncertain impact.

Before submitting, establish a controlled reproduction, the actual security
impact, affected versions, and a minimal set of steps the program permits.
Use the program's stated report channel. REA does not submit reports or infer
authorization from a case file.
