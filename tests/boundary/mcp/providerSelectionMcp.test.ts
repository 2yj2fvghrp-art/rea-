import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  createAnalysisExecution,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../../../src/application/AnalysisProvider.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";

const resources: Array<{ close(): Promise<unknown> }> = [];
let directory: string | undefined;
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** Connected MCP session over two configured deep providers for one target. */
const selectionHarness = async () => {
  directory = await createTestTempDirectory("rea-provider-mcp-");
  const target = join(directory, "fixture.hop");
  await writeFile(target, "fixture");
  const starts: string[] = [];
  const session = composeBinarySession(
    new AnalysisProviderRegistry([
      candidate("beta", starts),
      candidate("alpha", starts),
    ]),
  );
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const mcp = new Client({ name: "provider-selection", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(mcp, server);
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return { mcp, target, starts };
};

describe("provider selection over MCP", () => {
  it("reports target-free discovery and rejects a malformed selector", async () => {
    const { mcp, target, starts } = await selectionHarness();

    const before = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    expect(before.result).toMatchObject({
      open: false,
      analysis_provider_selection_state: null,
      analysis_run: null,
      analysis_provider_binding: null,
      analysis_provider_candidates: [
        {
          provider: { id: "alpha" },
          target_support: { status: "unknown" },
          eligibility: "unevaluated",
          selected: false,
        },
        {
          provider: { id: "beta" },
          target_support: { status: "unknown" },
          eligibility: "unevaluated",
          selected: false,
        },
      ],
    });
    expect(starts).toEqual([]);

    const malformed = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target, provider_id: "Beta" },
    });
    expect(malformed.isError).toBe(true);
    expect(starts).toEqual([]);
  });

  it("admits a multi-candidate target in the selection-required state", async () => {
    const { mcp, target, starts } = await selectionHarness();

    // Two eligible providers: automatic selection admits the target without
    // binding or starting an engine, and reports that a decision is required.
    const undecided = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target },
    });
    expect(undecided.isError).not.toBe(true);
    expect(structured(undecided).result).toMatchObject({
      path: target,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(starts).toEqual([]);

    const pending = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    expect(pending.result).toMatchObject({
      open: true,
      analysis_provider_selection_state: "selection_required",
      analysis_provider_binding: null,
      analysis_provider_candidates: [
        {
          provider: { id: "alpha" },
          eligibility: "eligible",
          selected: false,
        },
        {
          provider: { id: "beta" },
          eligibility: "eligible",
          selected: false,
        },
      ],
    });
    expect(starts).toEqual([]);

    // A deep operation before the caller decides stays typed and actionable.
    const premature = await mcp.callTool({
      name: "address_name",
      arguments: {},
    });
    expect(premature.isError).toBe(true);
    expect(structured(premature)).toMatchObject({
      error: {
        details: {
          selection_reason: "ambiguous",
          requested_provider_id: "auto",
          candidate_ids: ["alpha", "beta"],
        },
      },
    });
    expect(starts).toEqual([]);
  });

  it("binds an explicitly selected provider and keeps it stable", async () => {
    const { mcp, target, starts } = await selectionHarness();

    const opened = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target, provider_id: "beta" },
    });
    expect(opened.isError).not.toBe(true);
    expect(starts).toEqual([]);

    const observed = await mcp.callTool({
      name: "address_name",
      arguments: {},
    });
    expect(observed.isError).not.toBe(true);
    expect(structured(observed)).toMatchObject({
      normalized_result: "beta:address_name",
      evidence_id: expect.stringMatching(/^ev_/u),
    });
    expect(starts).toEqual(["beta"]);

    const status = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    expect(status.result).toMatchObject({
      open: true,
      analysis_provider_selection_state: "bound",
      analysis_run: {
        run_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        process_lineage: { status: "not_observed" },
      },
      analysis_provider_binding: {
        provider: { id: "beta", version: "1" },
        selection_source: "request",
      },
      analysis_provider_candidates: [
        {
          provider: { id: "alpha" },
          eligibility: "unevaluated",
          selected: false,
        },
        {
          provider: { id: "beta", version: "1" },
          eligibility: "eligible",
          selected: true,
        },
      ],
    });

    const unknown = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target, provider_id: "missing" },
    });
    expect(unknown.isError).toBe(true);
    expect(structured(unknown)).toMatchObject({
      error: { details: { selection_reason: "unknown_provider" } },
    });
    expect(
      structured(await mcp.callTool({ name: "binary_session", arguments: {} }))
        .result,
    ).toMatchObject({
      analysis_provider_binding: { provider: { id: "beta" } },
    });
  });
});

const candidate = (id: string, starts: string[]): AnalysisProviderCandidate => {
  const identity: ProviderIdentity = {
    id,
    name: `${id} provider`,
    version: null,
  };
  return {
    identity: () => identity,
    capabilities: () => [capability(identity)],
    inspectAvailability: () => ({
      status: "available",
      code: null,
      reason: null,
      diagnostics: { executable_path: `/opt/${id}/bin/analyze` },
    }),
    inspectTargetSupport: () => ({
      status: "supported",
      code: null,
      reason: null,
      diagnostics: {},
    }),
    resolveAnalysisProfile: () =>
      Promise.resolve(
        ok({
          profile: createAnalysisProfile(
            { id, name: identity.name, version: "1" },
            { fixture: id },
          ),
        }),
      ),
    createClient: (_target, profile) => {
      starts.push(id);
      return {
        execute: (operation) =>
          Promise.resolve(
            ok(
              createAnalysisExecution(
                `${id}:${operation}`,
                profile?.provider ?? identity,
              ),
            ),
          ),
        close: () => Promise.resolve(ok(null)),
      };
    },
  };
};

const capability = (provider: ProviderIdentity): CapabilityDescriptor => ({
  provider,
  operation: "address_name",
  available: true,
  reason: null,
  effects: {
    mutatesArtifact: false,
    launchesProcess: true,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

const structured = (result: CallToolResult): Record<string, unknown> =>
  result.isError === true
    ? parseMcpToolError(result)
    : z.record(z.string(), z.unknown()).parse(result.structuredContent);
