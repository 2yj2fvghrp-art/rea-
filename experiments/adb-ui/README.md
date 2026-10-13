# ADB UI scope experiment

This draft contains a small, unshipped UIAutomator/input experiment and an
independently useful fix to the existing `inspect_adb_window` observation.
New public UI mutation tools require the maintainer scope decision described in
[CONTRIBUTING.md](../../CONTRIBUTING.md#contribution-scope).

## Observed behavior

- Android 16/API 36 puts `mCurrentFocus` and `mFocusedApp` in display state, outside
  `dumpsys window windows`. The existing tool now reads the complete report,
  retains source lines and leaves conflicting declarations unresolved.
- `uiautomator dump --compressed /proc/self/fd/1` streams the hierarchy and a
  status footer without creating a device-side dump file. The projection keeps
  parent relationships, attributes, bounds and the XML digest. Password-marked
  text is excluded; ambiguous controls cannot supply action coordinates.
- A source-built fixture demonstrated a tap counter change, ASCII text entry,
  scrolling and BACK dispatch. Focus is checked before each input. These are
  sequential observations, not an atomic guarantee against UI changes.
- Existing CLI/MCP operations install/start the fixture, inspect focus and take
  a screenshot. Cleanup uninstalls the fixture and verifies its absence.

## Run

Supply compatible existing Android tools, a framework JAR and D8 JAR. Outputs
must be new directories outside the repository; generated APKs and keys are not
source artifacts.

```sh
npm ci
npm run build:cached
node --test experiments/adb-ui/hierarchy.test.mjs experiments/command-scope.test.mjs
node experiments/adb-ui/build-fixture.mjs --aapt2 /tools/aapt2 \
  --framework /sdk/android.jar --d8 /sdk/d8.jar --output /lab/ui-fixture
node experiments/adb-ui/verify.mjs --serial emulator-5554 \
  --apk /lab/ui-fixture/ui-probe.apk --output /lab/ui-result
```

The verifier requires an emulator and refuses an already-installed
`com.rea.ui.probe` package. The selected adb server follows the caller's normal
ADB environment. The shared command scope handles cancellation, output bounds
and failed cleanup without discarding the original error.

## Verification and remaining questions

Linux, adb 34.0.5, Android 16/API 36 x86-64 emulator, Node 24.18.0 and a source-built
probe passed the live experiment. Six projection tests and three command tests
cover malformed XML, invalid bounds, ambiguous selection, marked-sensitive text,
output truncation, producer failure and cancellation. Existing ADB parser/provider
regressions also pass. No new public CLI/MCP UI contract is registered yet.

An indicative warm-cache run took 50.42 s elapsed and 15.80 s host CPU, with a
887,607,296-byte host cgroup memory peak. Payload-exit counters and host process
cleanup were verified; final whole-scope counters disappeared after scope exit.
The observer is included; the external ADB server/emulator and agent-token usage
are unmeasured. The AAPT2 experiment ran concurrently on the same pinned CPU, so
these are not comparative performance results. Cold runs remain unmeasured.

The experimental XML input budget is 1 MiB. Production graph/serialization limits,
arbitrary Unicode text, multiple displays, rotation races, accessibility-service
effects and broad application coverage still need design and verification. Scope
review should decide the public hierarchy and single-action interfaces before
those capabilities are integrated.
