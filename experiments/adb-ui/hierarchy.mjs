import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";

// This is a bounded experimental producer projection, not a public REA contract.
export const XML_BYTES = 1024 * 1024;
const fail = (reason) => ({
  ok: false,
  error: { kind: "invalid-ui-dump", reason },
});

/** Separate the CLI's fixed status footer from the streamed XML document. */
export function projectDump(stdout) {
  const footer = "UI hierchary dumped to: /proc/self/fd/1";
  const value = stdout.trimEnd();
  if (!value.endsWith(footer))
    return fail(
      "The streamed UI dump did not report its expected output target",
    );
  return projectHierarchy(value.slice(0, -footer.length));
}

export function projectHierarchy(xml) {
  if (typeof xml !== "string" || Buffer.byteLength(xml) > XML_BYTES)
    return fail("UI XML exceeds the experimental 1 MiB input budget");
  const diagnostics = [];
  let document;
  try {
    document = new DOMParser({
      onError: (_level, message) => diagnostics.push(message),
    }).parseFromString(xml, "application/xml");
  } catch (cause) {
    return fail(String(cause));
  }
  if (
    diagnostics.length ||
    document.doctype ||
    document.documentElement?.tagName !== "hierarchy"
  )
    return fail(
      diagnostics[0] ?? "Expected a hierarchy document without a DTD",
    );
  const nodes = [];
  const pending = [{ element: document.documentElement, parent: null }];
  while (pending.length) {
    const { element, parent } = pending.pop();
    let nextParent = parent;
    if (element.tagName === "node") {
      const attributes = Object.fromEntries(
        Array.from(element.attributes, (attribute) => [
          attribute.name,
          attribute.value,
        ]),
      );
      const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u.exec(
        attributes.bounds ?? "",
      );
      const coordinates = match?.slice(1).map(Number);
      const bounds =
        coordinates?.every(
          (value) =>
            Number.isInteger(value) &&
            value >= -2147483648 &&
            value <= 2147483647,
        ) &&
        coordinates[2] >= coordinates[0] &&
        coordinates[3] >= coordinates[1]
          ? {
              left: coordinates[0],
              top: coordinates[1],
              right: coordinates[2],
              bottom: coordinates[3],
            }
          : null;
      // Android explicitly marks password controls; retain the marker, not text.
      const redacted =
        attributes.password === "true" && Object.hasOwn(attributes, "text");
      if (redacted) delete attributes.text;
      nextParent = nodes.length;
      nodes.push({
        id: nextParent,
        parent,
        attributes,
        bounds,
        text_redacted: redacted,
      });
    } else if (element !== document.documentElement)
      return fail(`Unexpected UI element ${element.tagName}`);
    const children = [];
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) children.push(child);
      else if (
        (child.nodeType === 3 || child.nodeType === 4) &&
        child.data.trim() !== ""
      )
        return fail("Unexpected UI text content");
    }
    for (const child of children.reverse())
      pending.push({ element: child, parent: nextParent });
  }
  return {
    ok: true,
    value: {
      xml_sha256: createHash("sha256").update(xml).digest("hex"),
      rotation: document.documentElement.hasAttribute("rotation")
        ? document.documentElement.getAttribute("rotation")
        : null,
      nodes,
    },
  };
}

export function uniqueControl(snapshot, packageName, description) {
  const matches = snapshot.nodes.filter(
    (node) =>
      node.attributes.package === packageName &&
      node.attributes["content-desc"] === description,
  );
  if (matches.length !== 1)
    return {
      ok: false,
      error: { kind: "unresolved-control", matches: matches.length },
    };
  const node = matches[0];
  if (
    node.bounds === null ||
    node.attributes.enabled !== "true" ||
    node.bounds.right === node.bounds.left ||
    node.bounds.bottom === node.bounds.top
  )
    return { ok: false, error: { kind: "unusable-control", id: node.id } };
  return { ok: true, value: node };
}

/** Derive points without changing source bounds; both rectangles must contain them. */
export function actionPoints(control, display, action) {
  const invalid = (reason) => ({
    ok: false,
    error: { kind: "invalid-action-points", reason },
  });
  if (
    ![display?.width, display?.height].every(
      (value) => Number.isInteger(value) && value > 0 && value <= 2147483647,
    )
  )
    return invalid("Display dimensions are unresolved");
  const bounds = control.bounds;
  if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top)
    return invalid("Control bounds are unusable");
  const x = Math.floor((bounds.left + bounds.right) / 2);
  let points;
  if (action === "tap")
    points = [{ x, y: Math.floor((bounds.top + bounds.bottom) / 2) }];
  else if (action === "swipe") {
    const inset = Math.floor((bounds.bottom - bounds.top) / 4);
    points = [
      { x, y: bounds.bottom - 1 - inset },
      { x, y: bounds.top + inset },
    ];
    if (points[0].y <= points[1].y)
      return invalid("Control is too short for an upward swipe");
  } else return invalid("Unsupported action");
  if (
    points.some(
      ({ x, y }) =>
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= display.width ||
        y >= display.height ||
        x < bounds.left ||
        x >= bounds.right ||
        y < bounds.top ||
        y >= bounds.bottom,
    )
  )
    return invalid("Action point is outside the selected control or display");
  return { ok: true, value: points };
}
