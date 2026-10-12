import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import type { FridaInstrumentationPort } from "./FridaInstrumentationPort.js";
import { FridaInstrumentationService } from "./FridaInstrumentationService.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";

const createSession = () => ({
  sessionId: "00000000-0000-4000-8000-000000000001",
  deviceId: "local",
  target: "fixture",
  pid: 10,
  mode: "spawn" as const,
  state: "paused" as const,
});

const createScriptObservation = () => ({
  scriptId: "00000000-0000-4000-8000-000000000002",
  sourceKind: "inline" as const,
  sourcePath: null,
  sourceSha256: "a".repeat(64),
  messages: [],
  messagesTruncated: false,
});

const createProvider = (
  overrides: Partial<FridaInstrumentationPort> = {},
): FridaInstrumentationPort => ({
  async listDevices() {
    return { ok: true, value: { devices: [], cleanupError: null } };
  },
  async listProcesses() {
    return {
      ok: true,
      value: { deviceId: "local", processes: [], cleanupError: null },
    };
  },
  async startSession() {
    return { ok: true, value: createSession() };
  },
  async loadScript() {
    return { ok: true, value: createScriptObservation() };
  },
  async resumeSession() {
    return { ok: true, value: null };
  },
  async unloadScript() {
    return { ok: true, value: null };
  },
  status() {
    return undefined;
  },
  async closeSession() {
    return { ok: true, value: { targetResumeObserved: false } };
  },
  async closeAll() {},
  ...overrides,
});

it.each(["startSession", "instrument"] as const)(
  "does not start Frida when %s receives an already-cancelled signal",
  async (method) => {
    let starts = 0;
    let loads = 0;
    const provider = createProvider({
      async startSession() {
        starts += 1;
        return { ok: true, value: createSession() };
      },
      async loadScript() {
        loads += 1;
        return { ok: true, value: createScriptObservation() };
      },
    });
    const service = new FridaInstrumentationService(provider);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before call"));

    const result =
      method === "startSession"
        ? await service.startSession(
            { mode: "spawn", deviceId: "local", program: "/tmp/fixture" },
            controller.signal,
          )
        : await service.instrument(
            {
              mode: "spawn",
              deviceId: "local",
              program: "/tmp/fixture",
              source: { sourceKind: "inline", source: "send('ready');" },
              durationMs: 1,
            },
            controller.signal,
          );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(starts).toBe(0);
    expect(loads).toBe(0);
  },
);

it("does not resume a spawned target when cancellation arrives during script loading", async () => {
  const controller = new AbortController();
  let resumes = 0;
  let closes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        controller.abort(new Error("cancelled while loading"));
        return { ok: true, value: createScriptObservation() };
      },
      async resumeSession() {
        resumes += 1;
        return { ok: true, value: null };
      },
      async closeSession() {
        closes += 1;
        return { ok: true, value: { targetResumeObserved: true } };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
      source: { sourceKind: "inline", source: "send('ready');" },
      durationMs: 1,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        cleanup_error: null,
        target_state_before_cleanup: "paused",
        target_resume_observed: true,
        instrumentation_cleanup: "released",
        target_liveness_after_cleanup: "unknown",
      },
      parameters: {
        mode: "spawn",
        program: "/tmp/fixture",
      },
    });
  }
  expect(resumes).toBe(0);
  expect(closes).toBe(1);
});

it("rejects a missing script file before any device or target effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-frida-preflight-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  let starts = 0;
  let loads = 0;
  let closes = 0;
  let resumes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      async startSession() {
        starts += 1;
        return { ok: true, value: createSession() };
      },
      async loadScript() {
        loads += 1;
        return { ok: true, value: createScriptObservation() };
      },
      async resumeSession() {
        resumes += 1;
        return { ok: true, value: null };
      },
      async closeSession() {
        closes += 1;
        return { ok: true, value: { targetResumeObserved: false } };
      },
    }),
  );

  const missing = join(root, "missing-script.js");
  const result = await service.instrument({
    mode: "spawn",
    deviceId: "local",
    program: "/tmp/fixture",
    source: { sourceKind: "file", path: missing },
    durationMs: 1,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisInputError");
    expect(result.error).toMatchObject({
      issues: [{ path: ["path"], reason: "invalid_value", message: missing }],
    });
  }
  expect(starts).toBe(0);
  expect(loads).toBe(0);
  expect(resumes).toBe(0);
  expect(closes).toBe(0);
});

it("reads a selected script file once before starting the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-frida-preflight-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const scriptPath = join(root, "probe.js");
  await writeFile(scriptPath, "send('from-file');", "utf8");
  const calls: string[] = [];
  const service = new FridaInstrumentationService(
    createProvider({
      async startSession() {
        calls.push("start");
        return { ok: true, value: createSession() };
      },
      async loadScript(_sessionId, source) {
        calls.push("load");
        expect(source).toEqual({
          sourceKind: "inline",
          source: "send('from-file');",
        });
        return { ok: true, value: createScriptObservation() };
      },
      async resumeSession() {
        calls.push("resume");
        return { ok: true, value: null };
      },
      async closeSession() {
        calls.push("close");
        return { ok: true, value: { targetResumeObserved: false } };
      },
    }),
  );

  const result = await service.instrument({
    mode: "spawn",
    deviceId: "local",
    program: "/tmp/fixture",
    source: { sourceKind: "file", path: scriptPath },
    durationMs: 1,
  });

  expect(result.ok).toBe(true);
  expect(calls).toEqual(["start", "load", "resume", "close"]);
});

it("maps an unreadable script file to access_denied before any session effect", async () => {
  let starts = 0;
  const denied = "C:\\restricted\\denied.js";
  const service = new FridaInstrumentationService(
    createProvider({
      async startSession() {
        starts += 1;
        return { ok: true, value: createSession() };
      },
    }),
    () =>
      Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
  );

  const result = await service.instrument({
    mode: "attach",
    deviceId: "local",
    pid: 10,
    source: { sourceKind: "file", path: denied },
    durationMs: 1,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisAccessDeniedError");
    expect(result.error.message).toContain(denied);
  }
  expect(starts).toBe(0);
});
it("reports the spawned session when cancellation arrives during resume", async () => {
  const controller = new AbortController();
  let closes = 0;
  const service = new FridaInstrumentationService(
    createProvider({
      async resumeSession() {
        controller.abort(new Error("cancelled while resuming"));
        return { ok: true, value: null };
      },
      status() {
        return {
          ...createSession(),
          state: "running",
          targetResumeObserved: true,
          scripts: [],
          messages: [],
          messagesTruncated: false,
        };
      },
      async closeSession() {
        closes += 1;
        return { ok: true, value: { targetResumeObserved: false } };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
      argv: ["--owned-fixture"],
      source: { sourceKind: "inline", source: "send('ready');" },
      durationMs: 60_000,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        target_state_before_cleanup: "running",
        target_resume_observed: true,
        instrumentation_cleanup: "released",
        target_liveness_after_cleanup: "unknown",
      },
      parameters: {
        argv: ["--owned-fixture"],
      },
    });
  }
  expect(closes).toBe(1);
});

it("does not infer a Frida resume for a running attached target on cancellation", async () => {
  const controller = new AbortController();
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        controller.abort(new Error("cancelled while loading"));
        return { ok: true, value: createScriptObservation() };
      },
      status() {
        return {
          ...createSession(),
          mode: "attach",
          state: "running",
          targetResumeObserved: false,
          scripts: [],
          messages: [],
          messagesTruncated: false,
        };
      },
      async closeSession() {
        return { ok: true, value: { targetResumeObserved: false } };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "attach",
      deviceId: "local",
      pid: 512,
      source: { sourceKind: "inline", source: "send('ready');" },
      durationMs: 0,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        target_state_before_cleanup: "running",
        target_resume_observed: false,
      },
    });
});

it("retains an observed spawn resume after the target detaches before cancellation", async () => {
  const controller = new AbortController();
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        controller.abort(new Error("cancelled after target exit"));
        return { ok: true, value: createScriptObservation() };
      },
      status() {
        return {
          ...createSession(),
          state: "detached",
          targetResumeObserved: true,
          scripts: [],
          messages: [],
          messagesTruncated: false,
        };
      },
      async closeSession() {
        return { ok: true, value: { targetResumeObserved: false } };
      },
    }),
  );

  const result = await service.instrument(
    {
      mode: "spawn",
      deviceId: "local",
      program: "/tmp/fixture",
      source: { sourceKind: "inline", source: "send('ready');" },
      durationMs: 0,
    },
    controller.signal,
  );

  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        target_state_before_cleanup: "detached",
        target_resume_observed: true,
      },
    });
});

it.each([
  { cleanupState: "running" as const, resumeObserved: true },
  { cleanupState: "paused" as const, resumeObserved: false },
])(
  "uses a spawned target state transition after failed cleanup ($cleanupState)",
  async ({ cleanupState, resumeObserved }) => {
    const controller = new AbortController();
    let statusCalls = 0;
    const service = new FridaInstrumentationService(
      createProvider({
        async loadScript() {
          controller.abort(new Error("cancelled while loading"));
          return { ok: true, value: createScriptObservation() };
        },
        status() {
          statusCalls += 1;
          return {
            ...createSession(),
            state: statusCalls === 1 ? "paused" : cleanupState,
            targetResumeObserved: false,
            scripts: [],
            messages: [],
            messagesTruncated: false,
          };
        },
        async closeSession() {
          return {
            ok: false,
            error: new AnalysisCapabilityUnavailableError(
              "frida",
              "close_frida_session",
              "session cleanup failed",
            ),
          };
        },
      }),
    );

    const result = await service.instrument(
      {
        mode: "spawn",
        deviceId: "local",
        program: "/tmp/fixture",
        source: { sourceKind: "inline", source: "send('ready');" },
        durationMs: 0,
      },
      controller.signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.partialObservation).toMatchObject({
        normalized_result: {
          instrumentation_cleanup: "incomplete_or_unknown",
          target_state_before_cleanup: "paused",
          target_resume_observed: resumeObserved,
        },
      });
  },
);

it("records target selection in Evidence without remote authentication values", async () => {
  const token = "synthetic-frida-token";
  const certificate = "synthetic-frida-certificate";
  const service = new FridaInstrumentationService(createProvider());

  const result = await service.instrument({
    mode: "spawn",
    remote: {
      address: "127.0.0.1:27042",
      token,
      certificate,
      origin: "rea-test",
      keepaliveInterval: 1_000,
    },
    program: "/tmp/fixture",
    argv: ["--marker", "selected-argument"],
    source: { sourceKind: "inline", source: "send('ready');" },
    durationMs: 1,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.evidence.parameters).toMatchObject({
    session_id: createSession().sessionId,
    remote: {
      address: "127.0.0.1:27042",
      origin: "rea-test",
      keepalive_interval: 1_000,
    },
    mode: "spawn",
    program: "/tmp/fixture",
    argv: ["--marker", "selected-argument"],
  });
  const parameters = JSON.stringify(result.value.evidence.parameters);
  expect(parameters).not.toContain(token);
  expect(parameters).not.toContain(certificate);
});

it("reports completed cleanup when closing the parent session releases a failed script", async () => {
  const service = new FridaInstrumentationService(
    createProvider({
      async loadScript() {
        return {
          ok: false,
          error: new AnalysisCapabilityUnavailableError(
            "frida",
            "load_frida_script",
            "script load failed",
            {
              cleanup: {
                reason: "script unload failed",
                resources: ["script-1"],
              },
            },
          ),
        };
      },
    }),
  );

  const result = await service.instrument({
    mode: "spawn",
    deviceId: "local",
    program: "/tmp/fixture",
    source: { sourceKind: "inline", source: "send('ready');" },
    durationMs: 1,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.cleanupIncomplete).toBe(false);
});

it("cleans up a session and returns typed cancellation after a pending start", async () => {
  let finishStart: (() => void) | undefined;
  let markStartCalled: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  const startCalled = new Promise<void>((resolve) => {
    markStartCalled = resolve;
  });
  const closed: string[] = [];
  const provider: FridaInstrumentationPort = {
    async listDevices() {
      return { ok: true, value: { devices: [], cleanupError: null } };
    },
    async listProcesses() {
      return {
        ok: true,
        value: { deviceId: "local", processes: [], cleanupError: null },
      };
    },
    async startSession() {
      markStartCalled?.();
      await startGate;
      return {
        ok: true,
        value: {
          sessionId: "00000000-0000-4000-8000-000000000001",
          deviceId: "local",
          target: "fixture",
          pid: 10,
          mode: "attach",
          state: "running",
        },
      };
    },
    async loadScript() {
      return {
        ok: false,
        error: new AnalysisInputError("load_frida_script"),
      };
    },
    async resumeSession() {
      return { ok: true, value: null };
    },
    async unloadScript() {
      return { ok: true, value: null };
    },
    status() {
      return undefined;
    },
    async closeSession(sessionId) {
      closed.push(sessionId);
      return { ok: true, value: { targetResumeObserved: false } };
    },
    async closeAll() {},
  };
  const service = new FridaInstrumentationService(provider);
  const controller = new AbortController();
  const pending = service.startSession(
    { mode: "attach", deviceId: "local", pid: 10 },
    controller.signal,
  );
  await startCalled;
  controller.abort(new Error("caller cancelled"));
  finishStart?.();

  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(closed).toEqual(["00000000-0000-4000-8000-000000000001"]);
});
