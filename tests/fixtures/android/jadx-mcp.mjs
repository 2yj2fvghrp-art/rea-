import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createHash } from "node:crypto";
import { z } from "zod";

// An actual child MCP server exercising the production stdio/process seam.
// It is a protocol fixture, not evidence of JADX decompiler support.
const mode = process.env.REA_FAKE_JADX_MODE ?? "normal";
const server = new McpServer({
  name: mode === "empty-server-identity" ? "" : "rea-jadx-bridge",
  version:
    mode === "empty-server-identity" ? "" : mode === "version" ? "99.0.0" : "1",
});
const requestedCount = Number.parseInt(
  process.env.REA_FAKE_JADX_CLASS_COUNT ?? "",
  10,
);
const generatedCount =
  Number.isInteger(requestedCount) && requestedCount >= 0
    ? requestedCount
    : mode === "large-inventory"
      ? 9000
      : 400;
const classes = [
  "fixture.Target",
  ...Array.from(
    { length: generatedCount },
    (_, index) => `fixture.Class${index}`,
  ),
  ...(mode === "duplicate-class-name" ? ["fixture.Target"] : []),
];
const methods = [
  {
    name: "onCreate",
    signature: "onCreate(Bundle): void",
    is_constructor: false,
    def_pos: 0,
  },
  {
    name: "choose",
    signature: "choose(String): void",
    is_constructor: false,
    def_pos: 0,
  },
  {
    name: "choose",
    signature: "choose(int): void",
    is_constructor: false,
    def_pos: 0,
  },
];
const text = (value) => ({ content: [{ type: "text", text: value }] });
const json = (value) => text(JSON.stringify(value));
const androidNamespace = "http://schemas.android.com/apk/res/android";
const manifestText = `<manifest xmlns:android="${androidNamespace}" package="fixture"><uses-permission android:name="android.permission.INTERNET"/><permission android:name="fixture.permission.PRIVATE" android:protectionLevel="signature"/><application android:name=".App"><activity android:name=".Target" android:exported="true"><intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><data android:scheme="https" android:host="example.test"/></intent-filter></activity><receiver android:name=".InternalReceiver" android:exported="false"/></application></manifest>`;
const attribute = (qualified_name, value) => ({
  qualified_name,
  local_name: qualified_name.includes(":")
    ? qualified_name.split(":").at(-1)
    : qualified_name,
  namespace_uri: qualified_name.startsWith("android:") ? androidNamespace : "",
  value,
});
const element = (element_name, attributes) => ({ element_name, attributes });
const manifestDeclarations = {
  status: "complete",
  source_sha256: createHash("sha256").update(manifestText).digest("hex"),
  manifest_attributes: [
    attribute("package", "fixture"),
    attribute("xmlns:android", androidNamespace),
  ],
  applications: [element("application", [attribute("android:name", ".App")])],
  requested_permissions: [
    element("uses-permission", [
      attribute("android:name", "android.permission.INTERNET"),
    ]),
  ],
  defined_permissions: [
    element("permission", [
      attribute("android:name", "fixture.permission.PRIVATE"),
      attribute("android:protectionLevel", "signature"),
    ]),
  ],
  components: [
    {
      element_name: "activity",
      attributes: [
        attribute("android:name", ".Target"),
        attribute("android:exported", "true"),
      ],
      intent_filters: [
        {
          attributes: [],
          actions: [
            element("action", [
              attribute("android:name", "android.intent.action.VIEW"),
            ]),
          ],
          categories: [
            element("category", [
              attribute("android:name", "android.intent.category.DEFAULT"),
            ]),
          ],
          data: [
            element("data", [
              attribute("android:scheme", "https"),
              attribute("android:host", "example.test"),
            ]),
          ],
        },
      ],
    },
    {
      element_name: "receiver",
      attributes: [
        attribute("android:name", ".InternalReceiver"),
        attribute("android:exported", "false"),
      ],
      intent_filters: [],
    },
  ],
};
const register = (name, handler) =>
  server.registerTool(name, { inputSchema: z.looseObject({}) }, handler);
register("rea_jvm_status", () =>
  json({
    engine_reported_version: mode === "engine-version" ? "0.7.0" : "0.7.1",
    max_heap_bytes: 8 * 1024 * 1024 * 1024,
    available_processors: 4,
    java_version: "21-fixture",
    metadata_scope: "parsed_members",
  }),
);
register("load_apk", async ({ path }) => {
  if (mode === "stall") await new Promise(() => {});
  return json({
    state: "LOADED",
    apk_path: mode === "wrong-apk" ? "/different.apk" : path,
    class_count: classes.length,
    resource_count: 1,
    threads: 1,
    resources: "full",
  });
});
register("get_app_info", () => {
  if (mode === "rpc-disconnect") process.exit(17);
  return json({
    package: "fixture",
    version_name: "1",
    version_code: "1",
    min_sdk: "26",
    target_sdk: "33",
    permissions: ["android.permission.INTERNET"],
  });
});
register("get_android_manifest", () => {
  if (mode === "tool-error" || mode === "cleanup-failure")
    return {
      ...text("manifest decoder rejected malformed binary XML"),
      isError: true,
    };
  if (mode === "frame-overflow") return text("x".repeat(9 * 1024 * 1024));
  if (mode === "large-manifest") return text("x".repeat(1024 * 1024));
  return text(manifestText);
});
register("rea_manifest_declarations", () => {
  if (mode === "large-manifest" || mode === "manifest-declarations-unavailable")
    return json({
      status: "unavailable",
      reason: "Decoded manifest exceeds the declaration parsing budget",
    });
  if (mode === "wrong-manifest-identity")
    return json({ ...manifestDeclarations, source_sha256: "0".repeat(64) });
  return json(manifestDeclarations);
});
register("list_classes", ({ offset, limit }) =>
  json({
    total: classes.length,
    offset,
    limit,
    items: mode === "empty-page" ? [] : classes.slice(offset, offset + limit),
  }),
);
register("get_class_summary", () =>
  json({
    full_name: mode === "wrong-class" ? "fixture.Other" : "fixture.Target",
    name: "Target",
    method_count: mode === "summary-error" ? -1 : methods.length,
    field_count: 0,
    inner_class_count: 0,
    methods: mode === "summary-error" ? [] : methods,
    fields: [],
    inner_classes: [],
    ...(mode === "summary-error" ? { error: "summary timed out" } : {}),
  }),
);
register("get_method_body", ({ method_name, overload_index }) =>
  json({
    class_name: "fixture.Target",
    method_name,
    full_name: `fixture.Target.${method_name}`,
    overload_index:
      mode === "wrong-method" ? overload_index + 1 : overload_index,
    overload_count: method_name === "choose" ? 2 : 1,
    mode: mode === "smali" || mode === "overloaded-smali" ? "smali" : "java",
    fell_back: mode === "smali" || mode === "overloaded-smali",
    markers:
      mode === "smali" || mode === "overloaded-smali"
        ? ["Method not decompiled"]
        : [],
    body:
      mode === "no-body"
        ? "// method exists but has no decompiled body (native/abstract)"
        : mode === "body-error"
          ? "// ERROR: decompile timed out or failed"
          : mode === "truncated"
            ? "void onCreate(){}\n\n... [truncated: exceeds 18 bytes, total 100 bytes]"
            : `void ${method_name}() { /* overload ${overload_index} */ }`,
  }),
);
for (const name of ["get_xrefs_to_class", "get_xrefs_to_method"])
  register(name, ({ class_name, method_name }) =>
    json({
      target:
        method_name === undefined ? class_name : `${class_name}.${method_name}`,
      total: mode === "partial-xrefs" ? 2 : 1,
      count: 1,
      resolve_line: false,
      items: [
        {
          kind: "method",
          name: "caller",
          full_name: "fixture.Other.caller",
          containing_class: "fixture.Other",
          top_class: "fixture.Other",
          def_pos: 42,
        },
      ],
    }),
  );
await server.connect(new StdioServerTransport());
// A refused cleanup must leave a live process for verified fixture teardown.
// Otherwise stdin EOF races the ownership scan with the server's natural exit.
if (mode === "cleanup-failure") setInterval(() => {}, 1000);
