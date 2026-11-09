/**
 * The product's file written with AI (758 [STN5], unit 3): the rules the
 * studio and the server share (lib/ai-file-rules.ts), and the lines a run of
 * a file's parts is told in (lib/ai-steps.ts). What is checked:
 *   - each request is priced at most a writing job, on every model a
 *     deployment may pick, so a file of n parts takes n jobs and no credit
 *     or limit of its own;
 *   - a plan has at most MAX_FILE_SECTIONS parts, each written by its title;
 *   - a plan, a part and a file sent to be saved are read exactly: a part cut
 *     off, a web address, a heading or a list mark never reaches the file;
 *   - a part's step and a stop that brings back what was already written are
 *     read in their exact shape, and nothing else is.
 */
import { SUPPORTED_AI_MODELS } from "@/lib/ai-request-rules";
import { aiRequestHoldMicroUsd, WRITING_JOB_MICRO_USD } from "@/lib/spend-cost-table";
import {
  FILE_BATCH,
  FILE_OUTLINE_OUTPUT_TOKENS,
  FILE_PROMPT_BYTES,
  FILE_SECTION_OUTPUT_TOKENS,
  FILE_SYSTEM_BYTES,
  MAX_FILE_SECTIONS,
  MAX_SECTION_CHARS,
  SECTION_END,
  cleanSectionBody,
  fileJobs,
  filePages,
  fileSteps,
  parseOutline,
  readFileDraft,
  readOutlineInput,
  readSectionText,
} from "@/lib/ai-file-rules";
import { isStepId, readStepLine } from "@/lib/ai-steps";
import { done, is, part } from "./check";

function main(): void {
  part("Each request is priced at most a writing job, on every model");
  for (const [what, maxTokens] of [["a part", FILE_SECTION_OUTPUT_TOKENS], ["the plan", FILE_OUTLINE_OUTPUT_TOKENS]] as const) {
    is(
      `${what}, at its biggest`,
      SUPPORTED_AI_MODELS.map((model) => {
        const hold = aiRequestHoldMicroUsd(model, { inputBytes: FILE_SYSTEM_BYTES + FILE_PROMPT_BYTES, blocks: 1, media: null, maxTokens });
        return hold !== null && hold > 0 && hold <= WRITING_JOB_MICRO_USD;
      }),
      SUPPORTED_AI_MODELS.map(() => true),
    );
  }
  is("ten parts at the most, written five at a time", [MAX_FILE_SECTIONS, FILE_BATCH], [10, 5]);
  is("one writing job a part, none for nothing", [fileJobs(1), fileJobs(10), fileJobs(0), fileJobs(-1)], [1, 10, 0, 0]);
  is("about five pages a part", [filePages(1), filePages(10)], [5, 50]);
  is(
    "one step a part, named by its title",
    fileSteps(["Start here", "Week one"]),
    [
      { id: "section-1", label: "Writing part 1: Start here", jobs: 1 },
      { id: "section-2", label: "Writing part 2: Week one", jobs: 1 },
    ],
  );
  is("never more steps than parts may be", fileSteps(Array.from({ length: 12 }, (_, i) => `P${i}`)).length, MAX_FILE_SECTIONS);

  part("A plan the model wrote, made safe");
  const plan = parseOutline({
    title: "Weeknight Dinners https://example.com",
    sections: [
      { title: "Start here", points: ["What to buy", "", "x".repeat(200), "Tools", "One more"] },
      { title: "y".repeat(101), points: [] },
      "not a part",
      { title: "Week one", points: "not a list" },
    ],
  });
  is("addresses taken out, a part too long left out, at most three points", plan, {
    title: "Weeknight Dinners",
    sections: [
      { title: "Start here", points: ["What to buy", "Tools", "One more"] },
      { title: "Week one", points: [] },
    ],
  });
  is("never more than ten parts", parseOutline({ title: "T", sections: Array.from({ length: 14 }, (_, i) => ({ title: `P${i}`, points: [] })) })?.sections.length, 10);
  is("no parts, no plan", [parseOutline({ title: "T", sections: [] }), parseOutline(null), parseOutline({ sections: [{ title: "a", points: [] }] })], [null, null, null]);

  part("A plan sent back to be written is read exactly");
  const good = { title: "Weeknight Dinners", sections: [{ title: "Start here", points: ["What to buy"] }] };
  is("as sent", readOutlineInput(good), good);
  for (const [why, bad] of [
    ["an extra key", { ...good, x: 1 }],
    ["eleven parts", { title: "T", sections: Array.from({ length: 11 }, (_, i) => ({ title: `P${i}`, points: [] })) }],
    ["an empty point", { title: "T", sections: [{ title: "A", points: [""] }] }],
    ["a web address", { title: "T", sections: [{ title: "A https://x.example", points: [] }] }],
    ["a line break", { title: "T", sections: [{ title: "A\nB", points: [] }] }],
    ["four points", { title: "T", sections: [{ title: "A", points: ["a", "b", "c", "d"] }] }],
    ["no parts", { title: "T", sections: [] }],
  ] as const) {
    is(`refused: ${why}`, readOutlineInput(bad), null);
  }

  part("A part as the model wrote it");
  const text = `# Start here\n\nBuy rice and beans first.\nThey keep for months.\n\n- Rice\n- Beans see https://example.com/shop\n\n${SECTION_END}`;
  is("whole only with its end mark; headings, list marks and addresses taken out", readSectionText(text, "Start here"), {
    title: "Start here",
    body: "Start here\n\nBuy rice and beans first. They keep for months.\n\nRice Beans see",
  });
  is("a part cut off is not shown", readSectionText("Buy rice and beans first.", "Start here"), null);
  is("an empty part is not shown", readSectionText(SECTION_END, "Start here"), null);
  is("a part longer than a part may be is not shown", readSectionText(`${"word ".repeat(MAX_SECTION_CHARS / 4)}${SECTION_END}`, "Start here"), null);
  is("the creator's text: paragraphs kept, spaces folded", cleanSectionBody("  One  two \r\n\r\n\n three\tfour  "), "One two\n\nthree four");

  part("A file sent to be saved is read exactly");
  const draft = { title: "Weeknight Dinners", sections: [{ title: "Start here", body: "Buy rice.\n\nThen beans." }] };
  is("as sent", readFileDraft(draft), draft);
  for (const [why, bad] of [
    ["an empty part", { ...draft, sections: [{ title: "Start here", body: "" }] }],
    ["text not tidied", { ...draft, sections: [{ title: "Start here", body: "Buy  rice." }] }],
    ["a part too long", { ...draft, sections: [{ title: "Start here", body: "x".repeat(MAX_SECTION_CHARS + 1) }] }],
    ["an extra key", { ...draft, sections: [{ title: "Start here", body: "Buy rice.", html: "<b>" }] }],
    ["no title", { ...draft, title: "" }],
    ["eleven parts", { title: "T", sections: Array.from({ length: 11 }, () => ({ title: "A", body: "b" })) }],
  ] as const) {
    is(`refused: ${why}`, readFileDraft(bad), null);
  }

  part("A file's lines are read in their exact shape");
  is("a part's step", readStepLine('{"step":"section-3","state":"started"}'), { step: "section-3", state: "started" });
  is("parts one to ten only", [isStepId("section-1"), isStepId("section-10"), isStepId("section-0"), isStepId("section-11"), isStepId("section-01"), isStepId("section-1.5")], [true, true, false, false, false, false]);
  is("a part past ten is never a step", readStepLine('{"step":"section-11","state":"done"}'), null);
  is(
    "a stop that brings back what was written",
    readStepLine('{"done":true,"ok":false,"error":"stopped","returned":2,"left":30,"value":{"title":"T","sections":[]}}'),
    { done: true, ok: false, error: "stopped", returned: 2, left: 30, value: { title: "T", sections: [] } },
  );
  is(
    "and one whose give-back could not be confirmed",
    readStepLine('{"done":true,"ok":false,"error":"failed","returned":null,"left":null,"value":{"title":"T"}}'),
    { done: true, ok: false, error: "failed", returned: null, left: null, value: { title: "T" } },
  );
  is("a stop's value of nothing is not a line", readStepLine('{"done":true,"ok":false,"error":"stopped","returned":2,"left":30,"value":null}'), null);
  is("a value with nothing given back is not a line", readStepLine('{"done":true,"ok":false,"error":"stopped","returned":0,"left":30,"value":{}}'), null);

  done();
}

main();
