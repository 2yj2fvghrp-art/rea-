import assert from "node:assert/strict";
import test from "node:test";
import {
  projectDump,
  projectHierarchy,
  uniqueControl,
  XML_BYTES,
  actionPoints,
} from "./hierarchy.mjs";

const node = (attributes = "", children = "") =>
  `<node package="com.rea.ui.probe" content-desc="target" enabled="true" bounds="[0,10][100,40]" ${attributes}>${children}</node>`;
const parse = (body) =>
  projectHierarchy(`<hierarchy rotation="0">${body}</hierarchy>`);

test("action points respect the live display and original control bounds", () => {
  const display = { width: 1080, height: 2400 };
  for (const bounds of [
    "[-100,10][-20,40]",
    "[1080,0][1120,40]",
    "[0,2400][40,2440]",
  ]) {
    const control = parse(`<node bounds="${bounds}"/>`).value.nodes[0];
    assert.equal(actionPoints(control, display, "tap").ok, false);
    assert.equal(actionPoints(control, display, "swipe").ok, false);
    assert.equal(control.attributes.bounds, bounds);
  }
  const control = parse(node()).value.nodes[0];
  assert.deepEqual(actionPoints(control, display, "tap").value, [
    { x: 50, y: 25 },
  ]);
  // A 30px control cannot support the former fixed 80px offsets.
  assert.deepEqual(actionPoints(control, display, "swipe").value, [
    { x: 50, y: 32 },
    { x: 50, y: 17 },
  ]);
  assert.equal(
    actionPoints(control, { width: null, height: 2400 }, "tap").ok,
    false,
  );
  const tiny = parse('<node bounds="[0,0][10,1]"/>').value.nodes[0];
  assert.equal(actionPoints(tiny, display, "swipe").ok, false);
});

test("accepts the real UIAutomator stream footer and refuses truncated output", () => {
  assert.equal(
    projectDump(
      '<hierarchy rotation="0"/>UI hierchary dumped to: /proc/self/fd/1\n',
    ).ok,
    true,
  );
  assert.equal(projectDump('<hierarchy rotation="0"/>').ok, false);
});

test("retains source values, parent relationships and XML identity", () => {
  const result = parse(
    node('text="A &amp; B"', '<node package="other" bounds="[-5,0][4,8]"/>'),
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.nodes[0].attributes.text, "A & B");
  assert.equal(result.value.nodes[1].parent, 0);
  assert.equal(result.value.nodes[1].bounds.left, -5);
  assert.match(result.value.xml_sha256, /^[a-f0-9]{64}$/u);
});
test("does not choose the first ambiguous control or another package", () => {
  const duplicate = parse(node() + node()).value;
  assert.deepEqual(uniqueControl(duplicate, "com.rea.ui.probe", "target"), {
    ok: false,
    error: { kind: "unresolved-control", matches: 2 },
  });
  assert.equal(uniqueControl(duplicate, "other", "target").error.matches, 0);
});
test("preserves malformed bounds as unknown and refuses their action coordinates", () => {
  const result = parse(
    '<node package="com.rea.ui.probe" content-desc="target" enabled="true" bounds="[100,0][2,4]"/>',
  ).value;
  assert.equal(result.nodes[0].bounds, null);
  assert.equal(uniqueControl(result, "com.rea.ui.probe", "target").ok, false);
  assert.equal(
    parse('<node bounds="[0,0][2147483648,1]"/>').value.nodes[0].bounds,
    null,
  );
});
test("honors an explicit password marker without suppressing ordinary text", () => {
  const result = parse(
    node('password="true" text="sensitive"') +
      node('text="token=local-evidence"'),
  ).value;
  assert.equal(result.nodes[0].text_redacted, true);
  assert.equal(Object.hasOwn(result.nodes[0].attributes, "text"), false);
  assert.equal(result.nodes[1].attributes.text, "token=local-evidence");
});
test("rejects malformed, wrong-root, DTD and oversized producer data", () => {
  for (const value of [
    "<hierarchy><node></hierarchy>",
    "<other/>",
    "<hierarchy><![CDATA[unexpected text]]></hierarchy>",
    '<!DOCTYPE hierarchy [<!ENTITY x "value">]><hierarchy/>',
    "x".repeat(XML_BYTES + 1),
  ])
    assert.equal(projectHierarchy(value).ok, false);
});
