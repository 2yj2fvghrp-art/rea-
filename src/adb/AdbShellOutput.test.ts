import { describe, expect, it } from "vitest";

import {
  parseAmStartOutput,
  parseWindowFocusOutput,
} from "./AdbShellOutput.js";

const starting =
  "Starting: Intent { act=android.intent.action.MAIN cmp=com.example/.Main }";

describe("window focus ownership", () => {
  it("reads Android 16 display-scoped declarations and retains exact lines", () => {
    const lines = [
      "  mCurrentFocus=Window{97d4114 u0 com.rea.ui.probe/com.rea.ui.probe.Main}",
      "  mFocusedApp=ActivityRecord{114223865 u0 com.rea.ui.probe/.Main t8}",
    ];
    expect(
      parseWindowFocusOutput(
        `WINDOW MANAGER DISPLAY CONTENTS\n${lines.join("\n")}\n`,
      ),
    ).toEqual({
      focusedWindow:
        "Window{97d4114 u0 com.rea.ui.probe/com.rea.ui.probe.Main}",
      focusedApp: "ActivityRecord{114223865 u0 com.rea.ui.probe/.Main t8}",
      observedLines: lines,
    });
  });
  it("leaves conflicting display focus unresolved instead of selecting the first", () => {
    const lines = [
      "mCurrentFocus=Window{a u0 first/.Main}",
      "mCurrentFocus=Window{b u0 second/.Main}",
    ];
    expect(parseWindowFocusOutput(lines.join("\n"))).toEqual({
      focusedWindow: null,
      focusedApp: null,
      observedLines: lines,
    });
  });
  it("distinguishes declared null from missing observations and accepts repeated agreement", () => {
    expect(parseWindowFocusOutput("mCurrentFocus=null\n")).toEqual({
      focusedWindow: null,
      focusedApp: null,
      observedLines: ["mCurrentFocus=null"],
    });
    expect(parseWindowFocusOutput("").observedLines).toEqual([]);
    expect(
      parseWindowFocusOutput(
        "mFocusedApp=ActivityRecord{a}\nmFocusedApp=ActivityRecord{a}",
      ).focusedApp,
    ).toBe("ActivityRecord{a}");
  });
});

describe("parseAmStartOutput", () => {
  it("recognizes a CRLF wait-timeout report", () => {
    expect(
      parseAmStartOutput(
        `${starting}\r\nStatus: timeout\r\nActivity: com.example/.Main\r\nComplete\r\n`,
      ),
    ).toMatchObject({
      status: "refused",
      activity: "com.example/.Main",
      reportedStatus: "timeout",
      reason: "am start reported status: timeout",
    });
  });

  it("treats every non-ok status as refusal, including a later status after ok", () => {
    expect(
      parseAmStartOutput(`${starting}\nStatus: ok\nStatus: timeout\n`),
    ).toMatchObject({
      status: "refused",
      reportedStatus: "timeout",
      reason: "am start reported status: timeout",
    });
    expect(
      parseAmStartOutput(`${starting}\nStatus: future-value\n`),
    ).toMatchObject({
      status: "refused",
      reportedStatus: "future-value",
    });
  });

  it("gives hard errors in either stream priority over status and attempt", () => {
    expect(
      parseAmStartOutput(
        `${starting}\nStatus: timeout\nActivity: com.example/.Main\n`,
        "Exception: Activity class does not exist\n",
      ),
    ).toEqual({
      status: "refused",
      startedActivity: "act=android.intent.action.MAIN cmp=com.example/.Main",
      activity: "com.example/.Main",
      reportedStatus: "timeout",
      reason: "Activity class does not exist",
    });
    expect(
      parseAmStartOutput(
        `${starting}\nStatus: ok\nError: Activity class does not exist\n`,
      ),
    ).toMatchObject({
      status: "refused",
      reason: "Activity class does not exist",
    });
  });

  it("keeps Starting-only output compatible and refuses no-attempt output", () => {
    expect(parseAmStartOutput(starting)).toMatchObject({
      status: "started",
      reportedStatus: null,
      activity: null,
    });
    expect(
      parseAmStartOutput("Status: ok\nWarning: Activity not started\n"),
    ).toMatchObject({
      status: "refused",
      startedActivity: null,
      reportedStatus: "ok",
    });
  });
});
