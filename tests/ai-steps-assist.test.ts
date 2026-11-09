/**
 * What the creator sees while the writing help drafts a page step by step
 * (758 [STN5] unit 1; components/ai-steps-assist.tsx, lib/ai-steps.ts),
 * held to AX274: each step's state is said in words, never by colour alone;
 * only a change of step and the result are announced, politely, and the
 * clock that counts up is outside that region so a screen reader is not
 * talked over every second; Stop is a native button at least 44 by 44
 * pixels, offered only while a step is left that would not be charged; and
 * nothing moves unless the person allows motion.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { AiStepsProgress, elapsedWords } from "@/components/ai-steps-assist";
import { AI_RUN_ID, AI_STEP_EXTRA_BYTES, AI_STEP_PADDING_BYTES, AI_STOP_COMMANDS, pageSteps, readStepLine } from "@/lib/ai-steps";
import { READ_PDF_JOBS, READ_PDF_PAGES } from "@/lib/ai-rules";
import { done, is, part } from "./check";

const draw = (props: Parameters<typeof AiStepsProgress>[0]) => renderToStaticMarkup(createElement(AiStepsProgress, props));
const live = (html: string) => /<p[^>]*role="status"[^>]*aria-live="polite"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null;

function main(): void {
  part("The steps of a page, from the code");
  const two = pageSteps(true);
  is("with the PDF: reading, then writing, with the jobs each takes", two.map((s) => [s.id, s.jobs]), [["read", READ_PDF_JOBS], ["write", 1]]);
  is("named in plain words", two.map((s) => s.label), [`Reading the first ${READ_PDF_PAGES} pages of your PDF`, "Writing your page"]);
  is("without it: writing only", pageSteps(false).map((s) => s.id), ["write"]);
  is("a run id is 16 to 40 plain characters", [AI_RUN_ID.test("a".repeat(16)), AI_RUN_ID.test("a".repeat(15)), AI_RUN_ID.test("a".repeat(41)), AI_RUN_ID.test("aaaaaaaa aaaaaaaa")], [true, false, false, false]);
  is("the figures the cost line reads are whole and positive", [AI_STOP_COMMANDS, AI_STEP_EXTRA_BYTES > AI_STEP_PADDING_BYTES, AI_STEP_PADDING_BYTES >= 1024], [3, true, true]);

  part("Lines from the server are read in their exact shape");
  is("a step", readStepLine('{"step":"read","state":"started"}'), { step: "read", state: "started" });
  is("a draft", readStepLine('{"done":true,"ok":true,"value":{"a":1},"left":3}'), { done: true, ok: true, value: { a: 1 }, left: 3 });
  is("a stop with what came back", readStepLine('{"done":true,"ok":false,"error":"stopped","returned":1,"left":2}'), { done: true, ok: false, error: "stopped", returned: 1, left: 2 });
  is("a stop not confirmed", readStepLine('{"done":true,"ok":false,"error":"stopped","returned":null,"left":null}'), { done: true, ok: false, error: "stopped", returned: null, left: null });
  is("padding is skipped", readStepLine(`{"pad":"${" ".repeat(20)}"}`), "pad");
  for (const bad of ["", "not json", '{"step":"cook","state":"started"}', '{"step":"read","state":"maybe"}', '{"done":true,"ok":true,"left":-1,"value":1}', '{"done":true,"ok":false,"error":"stopped","returned":"1","left":2}', "[1]"]) {
    is(`an unknown line is never taken for a step or a result: ${bad || "(empty)"}`, readStepLine(bad), null);
  }

  part("While the reading runs");
  const running = draw({ steps: two, states: { read: "running", write: "waiting" }, announce: "Step 1 of 2: Reading the first 10 pages of your PDF", elapsed: 12, canStop: true, stopping: false, onStop: () => {} });
  is("each step's state is in words", [running.includes("Running"), running.includes("Not started")], [true, true]);
  is("an ordered list of the steps", /<ol[\s\S]*<li[\s\S]*<li[\s\S]*<\/ol>/.test(running), true);
  is("the polite region says only the change of step", live(running), "Step 1 of 2: Reading the first 10 pages of your PDF");
  is("the clock is outside it", [running.includes("Elapsed: 0:12"), (live(running) ?? "").includes("Elapsed")], [true, false]);
  const stop = /<button[^>]*>[^<]*Stop[^<]*<\/button>/.exec(running)?.[0] ?? "";
  is("Stop is a native button of its own type", /type="button"/.test(stop), true);
  is("at least 44 by 44 pixels", [/min-h-11/.test(stop), /min-w-11/.test(stop)], [true, true]);
  is("it says what it does not charge", /aria-describedby="[^"]+"/.test(stop) && running.includes("The step already running still counts. Steps not started are not charged."), true);

  part("Stopping, and a page of one step");
  const stopping = draw({ steps: two, states: { read: "running", write: "waiting" }, announce: "Stopping after this step.", elapsed: 15, canStop: true, stopping: true, onStop: () => {} });
  is("the button stays in place, says so, and does not take a second press", [/aria-disabled="true"/.test(stopping), stopping.includes("Stopping after this step")], [true, true]);
  const one = draw({ steps: pageSteps(false), states: { write: "running" }, announce: "Step 1 of 1: Writing your page", elapsed: 3, canStop: false, stopping: false, onStop: () => {} });
  is("no Stop when nothing is left that would not be charged", /<button/.test(one), false);
  const ended = draw({ steps: two, states: { read: "done", write: "skipped" }, announce: "Stopped.", elapsed: 20, canStop: false, stopping: false, onStop: () => {} });
  is("a step that never ran says it was not charged", ended.includes("Not run, not charged"), true);

  part("Words, motion and the clock");
  is("the clock reads in minutes and seconds", [elapsedWords(0), elapsedWords(9), elapsedWords(75), elapsedWords(3_600)], ["0:00", "0:09", "1:15", "60:00"]);
  const source = readFileSync("components/ai-steps-assist.tsx", "utf8");
  is("nothing animates unless motion is allowed", (source.match(/\banimate-/g) ?? []).length === (source.match(/motion-safe:animate-/g) ?? []).length, true);
  is("no state is told by colour alone: every state has its word", ["Not started", "Running", "Done", "Not run, not charged"].every((w) => source.includes(w)), true);

  done();
}

main();
