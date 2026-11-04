/**
 * 639 [GL7](8): duplicating a sales pipeline (lib/crm-rules.ts copyPipeline,
 * components/deals-board.tsx). The copy has the same stages, names and
 * kinds in order, every id new and unused, none of the deals (a deal names
 * a stage, so new stage ids hold none), a name the store does not use within
 * the limit, and is valid to save beside the others; the board opens it as a
 * new pipeline to read first, only while the plan has room for one more.
 */
import { readFileSync } from "node:fs";
import { MAX_PIPELINE_NAME, allStages, copyPipeline, parsePipelines, type Pipeline } from "@/lib/crm-rules";
import { done, is, part } from "./check";

const sales: Pipeline = {
  id: "sales0",
  name: "Sales",
  stages: [
    { id: "aaaaaa", name: "New", kind: "open" },
    { id: "bbbbbb", name: "Call booked", kind: "open" },
    { id: "cccccc", name: "Won", kind: "won" },
    { id: "dddddd", name: "Lost", kind: "lost" },
  ],
};
let n = 0;
const ids = () => ["aaaaaa", "sales0", "eeeeee", "ffffff", "gggggg", "hhhhhh", "iiiiii", "jjjjjj", "kkkkkk"][n++ % 9];

part("The copy");
const copy = copyPipeline(sales, [sales], ids);
is("same stages, names and kinds, in order", copy.stages.map((s) => [s.name, s.kind]), sales.stages.map((s) => [s.name, s.kind]));
is("a new pipeline id, never one the store has", copy.id !== "sales0", true);
is("new stage ids, none the store has", copy.stages.every((s) => !allStages([sales]).some((t) => t.id === s.id)), true);
is("named as a copy", copy.name, "Sales copy");
is("valid to save beside the original", parsePipelines([sales, copy])?.length, 2);
is("a second copy takes the next name", copyPipeline(sales, [sales, copy]).name, "Sales copy 2");
const long = { ...sales, name: "A".repeat(MAX_PIPELINE_NAME) };
is("a long name is cut to fit with its tail", [copyPipeline(long, [long]).name.length <= MAX_PIPELINE_NAME, copyPipeline(long, [long]).name.endsWith(" copy")], [true, true]);
is("the original is untouched", sales.stages[0].id, "aaaaaa");

part("The board");
const board = readFileSync("components/deals-board.tsx", "utf8");
is("opens the copy as a new pipeline to read first", board.includes("const copy = copyPipeline(pipeline, pipelines); setPipelineDraft({ ...copy, isNew: true"), true);
is("only while the plan has room for one more", board.split("pipelines.length < pipelineMax ?").length - 1 >= 1 && board.includes("pipelines.length < pipelineMax && canChange ?"), true);
is("the button names what it copies", board.includes("{`Duplicate “${nameOf(pipeline)}”`}"), true);
done();
