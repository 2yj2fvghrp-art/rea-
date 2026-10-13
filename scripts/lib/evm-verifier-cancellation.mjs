import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  observeProcessStartIdentity,
  systemProcessOwnershipHost,
} from "../../dist/process/ProcessOwnershipObservation.js";
import {
  descendantsOf,
  liveProcesses,
} from "../../dist/process/ProcessOwnershipProcessTree.js";
import { readProcessRunTokens } from "../../dist/process/ProcessRunTokenObservations.js";

/** Observe an admitted real worker within this verifier's selected child tree. */
export async function waitForEvmVerifierWorker(parentPid, settled) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const descendants = descendantsOf(
      [parentPid],
      liveProcesses(await systemProcessOwnershipHost.listProcesses()),
    );
    for (const process of descendants) {
      let args;
      try {
        args = (await readFile(`/proc/${process.pid}/cmdline`, "utf8"))
          .split("\0")
          .filter(Boolean);
      } catch (cause) {
        if (cause.code === "ENOENT") continue;
        throw cause;
      }
      if (
        !args.some((argument) => argument.endsWith("/EvmoleInterfaceWorker.js"))
      )
        continue;
      let token;
      for await (const { observation } of readProcessRunTokens(
        systemProcessOwnershipHost,
        [process],
      ))
        token = observation;
      if (
        token?.state !== "readable" ||
        !token.runId?.startsWith("rea-evm-interface-")
      )
        continue;
      const identity = await observeProcessStartIdentity(
        process.pid,
        systemProcessOwnershipHost,
        token.runId,
      );
      if (identity?.state !== "readable") continue;
      const requestPath = args.at(-1);
      const request = JSON.parse(await readFile(requestPath, "utf8"));
      assert.equal(dirname(request.snapshot_path), dirname(requestPath));
      return {
        pid: process.pid,
        identity: identity.identity,
        runId: token.runId,
        root: dirname(requestPath),
      };
    }
    assert.equal(
      settled(),
      false,
      "Operation completed before worker observation",
    );
    await delay(5);
  }
  throw new Error("Real EVM worker admission was not observed");
}

/** Distinguish exit/PID reuse from unknown identity, and require root cleanup. */
export async function assertEvmVerifierWorkerReleased(worker) {
  const current = await observeProcessStartIdentity(worker.pid);
  if (current !== undefined) {
    assert.equal(current.state, "readable", "Worker exit identity is unknown");
    assert.notEqual(
      current.identity,
      worker.identity,
      "Owned worker remains live",
    );
  }
  await assert.rejects(access(worker.root), { code: "ENOENT" });
}
