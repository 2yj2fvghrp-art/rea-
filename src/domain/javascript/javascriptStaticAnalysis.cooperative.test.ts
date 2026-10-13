import * as t from "@babel/types";
import { expect, it } from "vitest";

import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSourceSteps } from "./javascriptStaticAnalysis.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

it("bounds identifier work between static traversal checkpoints", () => {
  const source = Array.from(
    { length: 5000 },
    (_, i) => `require("./part-${String(i)}.cjs");`,
  ).join("\n");
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Fixture failed to parse");
  const reads = new Set<t.Identifier>();
  traverseJavaScriptAst(parsed, {
    enter(node) {
      if (!t.isIdentifier(node)) return;
      const name = node.name;
      Object.defineProperty(node, "name", {
        get() {
          reads.add(node);
          return name;
        },
      });
    },
  });
  const steps = analyzeParsedJavaScriptStaticSourceSteps(source, parsed);
  let maximumReads = 0;
  for (;;) {
    reads.clear();
    const step = steps.next();
    if (step.done) {
      expect(step.value.references).toHaveLength(5000);
      break;
    }
    maximumReads = Math.max(maximumReads, reads.size);
  }
  // Allow the tail of one 1,024-node traversal and the next traversal's
  // first chunk. Draining a whole 5,000-call classification violates this
  // bound independently of CPU speed. Final result projection is separate.
  expect(maximumReads).toBeLessThanOrEqual(2048);
});
