import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

// A recording port checks the experimental producer/consumer representation.
// Real provider verification remains in the separate native experiment receipts.
const generate = `
import {measureNativeEntry} from './experiments/analysis-efficiency/native-entry.mjs';
const sha='0'.repeat(64);
const dossier={procedure:{address:'0x1000'},pseudocode:'return;',callers:[],callees:[]};
class ToolFailure extends Error {}
const build=async digit=>{
  const parent='ev_'+digit.repeat(63)+'0';
  let ordinal=0;
  const call=async(name,args)=>{
    if(name==='open_binary'||name==='close_binary')return {};
    if(name==='resolve_containing_procedure')return {evidence_id:parent,normalized_result:{found:true}};
    if(name==='analyze_function')return {evidence_id:parent,subject:{digest:{sha256:sha}},normalized_result:dossier};
    const id='ev_'+digit.repeat(63)+(++ordinal);
    if(args.view.kind==='summary')return {evidence_id:id};
    const facet=args.view.facet;
    const item=facet==='pseudocode'?{text:dossier.pseudocode,unit:'utf16-code-units'}:dossier[facet];
    return {evidence_id:id,normalized_result:{parent_evidence_id:parent,artifact:{sha256:sha},item,coverage:{exhausted:true},limitations:[],unknowns:[]}};
  };
  return measureNativeEntry({seed:'0x1000',values:{path:'/selected/input','native-question':'entry-views'},call,inputSha:sha,ToolFailure});
};
process.stdout.write(JSON.stringify([await build('1'),await build('2')]));
`;

it.each(["references", "item", "coverage", "limitations", "unknowns"])(
  "separates native references while comparing %s exactly",
  async (change) => {
    const { stdout: generated } = await execute(process.execPath, [
      "--input-type=module",
      "-e",
      generate,
    ]);
    const [leftAnswer, rightAnswer] = JSON.parse(generated);
    if (change === "item")
      rightAnswer.retained_views[0].item.address = "0x1001";
    if (change === "coverage")
      rightAnswer.retained_views[0].coverage.exhausted = false;
    if (change === "limitations")
      rightAnswer.retained_views[0].limitations.push("partial");
    if (change === "unknowns")
      rightAnswer.retained_views[0].unknowns.push("unresolved");

    const root = await createTestTempDirectory("rea-native-comparison-");
    const left = join(root, "left");
    const right = join(root, "right");
    const summary = {
      artifact: "sharex.exe",
      native_question: "entry-views",
      provider_search_path_sha256: "0".repeat(64),
      native_workflow_source_sha256: "1".repeat(64),
      calls: [],
      failure: null,
    };
    for (const [directory, answer] of [
      [left, leftAnswer],
      [right, rightAnswer],
    ]) {
      await mkdir(directory);
      await writeFile(join(directory, "summary.json"), JSON.stringify(summary));
      await writeFile(join(directory, "answer.json"), JSON.stringify(answer));
    }
    const output = join(root, "comparison.json");
    const command = execute(process.execPath, [
      resolve("experiments/analysis-efficiency/compare.mjs"),
      "--left",
      left,
      "--right",
      right,
      "--output",
      output,
    ]);
    if (change !== "references") {
      await expect(command).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('"retained_views"'),
      });
      return;
    }
    const { stdout } = await command;
    expect(JSON.parse(stdout)).toMatchObject({
      settings_match: true,
      facts_match: true,
      preserved_run_specific_values: [
        {
          side: "left",
          path: ["evidence_ids"],
          value: leftAnswer.evidence_ids,
        },
        {
          side: "right",
          path: ["evidence_ids"],
          value: rightAnswer.evidence_ids,
        },
      ],
    });
    expect(leftAnswer.evidence_ids).not.toEqual(rightAnswer.evidence_ids);
    expect(leftAnswer.evidence_ids.retained_views[0]).toMatchObject({
      evidence_id: "ev_" + "1".repeat(64),
      parent_evidence_id: "ev_" + "1".repeat(63) + "0",
    });
    expect(leftAnswer.evidence_ids.native_summary).toBe(
      "ev_" + "1".repeat(63) + "5",
    );
  },
);
