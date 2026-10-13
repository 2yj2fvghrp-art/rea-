# ADB UI scope experiment

This draft contains a small, unshipped UIAutomator/input experiment and an
independently useful fix to the existing `inspect_adb_window` observation.
New public UI mutation tools require the maintainer scope decision described in
[CONTRIBUTING.md](../../CONTRIBUTING.md#contribution-scope).

## Observed behavior

- Android 16/API 36 puts `mCurrentFocus` and `mFocusedApp` in display state, outside
  `dumpsys window windows`. The existing tool now reads the complete report,
  retains live display/window source lines and leaves conflicting declarations
  unresolved. Saved ANR snapshots never contribute current focus.
- `uiautomator dump --compressed /proc/self/fd/1` streams the hierarchy and a
  status footer without creating a device-side dump file. The projection keeps
  parent relationships, attributes, bounds and the XML digest. Password-marked
  text is excluded; ambiguous controls cannot supply action coordinates.
- A source-built fixture demonstrated a tap counter change, ASCII text entry,
  scrolling and BACK dispatch. Focus is checked before each input. These are
  sequential observations, not an atomic guarantee against UI changes.
- AAPT2 inspects an owned APK snapshot's manifest package, including resource-free
  APKs. Existing CLI/MCP operations install/start those same bytes, inspect focus
  and take a screenshot. Action points must fit both the selected control and
  current screenshot dimensions; swipe endpoints scale with the control's height.
- An installation attempt owns cleanup before the command runs. Complete package
  inventory is required both before installing and after cleanup. A failed or
  cancelled install is reconciled, including failures parsing its host output.

## Run

Supply compatible existing Android tools, a framework JAR and D8 JAR. Outputs
must be new directories outside the repository; generated APKs and keys are not
source artifacts.

```sh
npm ci
npm run build:cached
node --test experiments/adb-ui/*.test.mjs experiments/command-scope.test.mjs
node experiments/adb-ui/build-fixture.mjs --aapt2 /tools/aapt2 \
  --framework /sdk/android.jar --d8 /sdk/d8.jar --output /lab/ui-fixture
node experiments/adb-ui/verify.mjs --aapt2 /tools/aapt2 --serial emulator-5554 \
  --apk /lab/ui-fixture/ui-probe.apk --output /lab/ui-result
```

The verifier requires an emulator and refuses an already-installed
`com.rea.ui.probe` package. The selected adb server follows the caller's normal
ADB environment and canonical REA binary selection, including blank settings.
Workflow MCP calls share the command cancellation signal; cleanup uses a fresh
120-second deadline. Primary, uninstall and close errors are aggregated, with
unresolved owners retained. `fixture-cleanup.json` records the admitted identity
before install and the complete absence observation after cleanup. Success is
reported only after cleanup and session closure finish.

## Verification and remaining questions

Linux, adb 34.0.5, Android 16/API 36 x86-64 emulator, Node 24.18.0 and a source-built
probe passed the live experiment. Seven projection tests, seven fixture lifecycle
tests and three command tests cover malformed XML, out-of-screen points, short
swipes, ambiguous selection, marked-sensitive text, output truncation, package
identity, source replacement, incomplete inventories, uncertain installs,
aggregated failures and MCP cancellation. Lifecycle tests use real filesystem
snapshots and in-memory MCP transport with scripted device/inspector outcomes;
they do not establish real-provider behavior. Existing ADB parser/provider
regressions also pass. No new public CLI/MCP UI contract is registered yet.

The post-review API 36 run also verified blank `REA_ADB_PATH` fallback and
AAPT2 `2.19-10229193` package admission. A different real APK was refused before
install. An ADB wrapper paused after a real successful install; SIGINT sent only
to the verifier cancelled the host workflow and cleanup proved the package absent.
Historical ANR nesting is covered by producer-format regressions; the live run
does not establish behavior on older Android versions.

The updated warm-cache workflow took 37.93 s elapsed and 12.91 s host CPU, with a
867,192,832-byte host cgroup memory peak. Payload-exit counters and host process
cleanup were verified; final whole-scope counters disappeared after scope exit.
The observer is included; the external ADB server/emulator and agent-token usage
are unmeasured. The earlier 50.42 s / 15.80 s / 887,607,296-byte run had a concurrent
AAPT2 workload and different emulator resource limits, so it is not a comparative
baseline. Cold runs remain unmeasured.

The experimental XML input budget is 1 MiB. Production graph/serialization limits,
arbitrary Unicode text, multiple displays, rotation races, accessibility-service
effects and broad application coverage still need design and verification. Scope
review should decide the public hierarchy and single-action interfaces before
those capabilities are integrated.
