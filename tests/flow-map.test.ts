/**
 * The picture of a workflow (lib/flow-map.ts, 391 [CX2] unit 1; added 12
 * November 2026). Checked:
 *
 *   - every arrow points where the job sends people (afterIndex, elseIndex),
 *     on hand-made flows and on 400 generated ones, the end included;
 *   - a condition's two answers are two arrows marked "Yes" and "No", and
 *     one plain arrow when both lead to the same box;
 *   - arrows to the next box go straight down; the others run down lanes,
 *     and no two arrows that share a lane overlap;
 *   - no "Yes" or "No" is written over any line, and an arrow coming into a
 *     box never runs along one leaving it;
 *   - words are wrapped, never cut, and every box and line stays inside the
 *     picture.
 */
import { BOX_WIDTH, LANE_WIDTH, LINE_CHARS, type FlowMapLayout, charWidth, flowMapLayout, flowRoutes, wrapWords } from "@/lib/flow-map";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowMap } from "@/components/workflow-tools";
import { END, type RoutedStep, afterIndex, checkRoutes, elseIndex } from "@/lib/flow-paths";
import type { StepCondition } from "@/lib/flow-rules";
import { done, is, part } from "./check";

const tagged = { if: "tagged", tag: "vip" } as unknown as StepCondition;
const label = (steps: readonly RoutedStep[]) => steps.map((s, i) => `${i + 1}. Step ${s.id}`);
const kinds = (layout: FlowMapLayout) => layout.arrows.map((a) => `${a.from}>${a.to}:${a.kind}${a.lane === null ? "" : `@${a.lane}`}`);

part("Words wrap, never cut");
{
  const text = "Email “A very long subject line that keeps going and going” Supercalifragilisticexpialidociousandthensome";
  const lines = wrapWords(text);
  is("no line is wider than a line may be", lines.every((l) => [...l].reduce((sum, c) => sum + charWidth(c), 0) <= LINE_CHARS), true);
  is("every character is kept", lines.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  is("a word longer than a line is broken inside, the rest kept whole", wrapWords("abcdefghij xy", 4), ["abcd", "efgh", "ij", "xy"]);
  is("an empty label is one empty line, not none", wrapWords("   "), [""]);
  is("an emoji is drawn twice as wide, and never split", wrapWords("🎉🎉🎉 ok", 6), ["🎉🎉🎉", "ok"]);
  const width = (line: string) => [...line].reduce((sum, c) => sum + charWidth(c), 0);
  const japanese = wrapWords("ワークショップの録画とボーナスのワークブックをお届けします今すぐ");
  is("a Japanese subject wraps by its width: no line wider than a line may be", [japanese.every((l) => width(l) <= LINE_CHARS), japanese.length > 1, japanese.join("")], [true, true, "ワークショップの録画とボーナスのワークブックをお届けします今すぐ"]);
  is("a line of W does not run out of its box", wrapWords("W".repeat(32)).every((l) => width(l) <= LINE_CHARS), true);
  is("capitals weigh more than small letters", [charWidth("A") > charWidth("a"), charWidth("W") > charWidth("A")], [true, true]);
}

part("A straight list");
{
  const steps: RoutedStep[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const layout = flowMapLayout(steps, label(steps));
  is("each step straight down to the next, the last to the end", kinds(layout), ["0>1:then", "1>2:then", "2>3:then"]);
  is("one box per step and the end", layout.boxes.map((b) => (b.end ? "End" : b.lines[0])), ["1. Step a", "2. Step b", "3. Step c", "End"]);
  is("no lanes", layout.lanes, 0);
  is("an empty workflow is only the end", kinds(flowMapLayout([], [])), []);
}

part("Conditions");
{
  const skip: RoutedStep[] = [{ id: "a", when: tagged, otherwise: "skip" }, { id: "b" }];
  is("only skipped: one plain arrow", kinds(flowMapLayout(skip, label(skip))), ["0>1:then", "1>2:then"]);
  const ends: RoutedStep[] = [{ id: "a" }, { id: "b", when: tagged, otherwise: "end" }, { id: "c" }];
  const layout = flowMapLayout(ends, label(ends));
  is("yes straight on, no down a lane to the end", kinds(layout), ["0>1:then", "1>2:yes", "1>3:no@0", "2>3:then"]);
  is("both answers are written in words", layout.arrows.map((a) => a.label?.text ?? null), [null, "Yes", "No", null]);
  // IF/ELSE: a asks; yes does b then jumps past the ELSE part to d; no goes to c.
  const ifElse: RoutedStep[] = [{ id: "a", when: tagged, otherwise: "jump", jump: "c" }, { id: "b", next: "d" }, { id: "c" }, { id: "d" }];
  is("an IF/ELSE: two lanes, because its arrows overlap", kinds(flowMapLayout(ifElse, label(ifElse))), ["0>1:yes", "0>2:no@0", "1>3:then@1", "2>3:then", "3>4:then"]);
  const apart: RoutedStep[] = [{ id: "a", when: tagged, next: "c", otherwise: "jump", jump: "d" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const two = flowMapLayout(apart, label(apart));
  const [yes, no] = two.arrows.filter((a) => a.from === 0);
  is("both answers over other boxes: they leave the box apart", yes.points[0][1] < no.points[0][1], true);
  is("a lane is shared by arrows that do not touch", kinds(flowMapLayout(
    [{ id: "a", next: "c" }, { id: "b" }, { id: "c" }, { id: "d", next: "f" }, { id: "e" }, { id: "f" }],
    label([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" }]),
  )), ["0>2:then@0", "1>2:then", "2>3:then", "3>5:then@0", "4>5:then", "5>6:then"]);
  const behind: RoutedStep[] = [{ id: "a" }, { id: "b", next: "a" }, { id: "c", next: "gone" }, { id: "d", next: END }];
  is("a target that is gone or behind ends the run, as in the job", kinds(flowMapLayout(behind, label(behind))), ["0>1:then", "1>4:then@0", "2>4:then@1", "3>4:then"]);
}

// Generated flows: forward routes only, as saveFlow keeps them.
let seed = 7;
const rand = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};
function generated(): RoutedStep[] {
  const count = 1 + rand(12);
  const steps: RoutedStep[] = [];
  for (let i = 0; i < count; i += 1) {
    const later = (i + 1 + rand(count - i)) as number;
    const step: RoutedStep = { id: `s${i}` };
    if (rand(3) === 0 && later < count) step.next = `s${later}`;
    else if (rand(6) === 0) step.next = END;
    if (rand(2) === 0) {
      step.when = tagged;
      const o = rand(3);
      const jumpTo = i + 1 + rand(Math.max(1, count - i - 1));
      if (o === 0 || jumpTo >= count) step.otherwise = o === 1 ? "end" : "skip";
      else if (o === 1) step.otherwise = "end";
      else {
        step.otherwise = "jump";
        step.jump = `s${jumpTo}`;
      }
    }
    steps.push(step);
  }
  return steps;
}

type Seg = [number, number, number, number];
const segs = (points: [number, number][]): Seg[] => points.slice(1).map((p, k) => [points[k][0], points[k][1], p[0], p[1]]);
// A label is written from its point, about 26 wide ("Yes" at 13px, bold) and 10 tall above its baseline.
const hits = (s: Seg, x: number, y: number) => {
  const [x1, y1, x2, y2] = s;
  const [lx, hx, ly, hy] = [Math.min(x1, x2), Math.max(x1, x2), Math.min(y1, y2), Math.max(y1, y2)];
  return hx >= x && lx <= x + 26 && hy >= y - 10 && ly <= y;
};

part("400 generated workflows");
{
  const wrong: string[] = [];
  for (let n = 0; n < 400; n += 1) {
    const steps = generated();
    if (checkRoutes(steps) !== null) {
      wrong.push(`generator made a bad route in ${JSON.stringify(steps)}`);
      continue;
    }
    const layout = flowMapLayout(steps, label(steps));
    const end = steps.length;
    const at = (j: number) => (j < 0 ? end : j);
    const tag = `flow ${n}`;
    steps.forEach((step, i) => {
      const mine = layout.arrows.filter((a) => a.from === i);
      const yes = at(afterIndex(steps, i));
      const no = step.when ? at(elseIndex(steps, i)) : yes;
      const want = yes === no ? [`${yes}:then`] : [`${yes}:yes`, `${no}:no`];
      const got = mine.map((a) => `${a.to}:${a.kind}`);
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${tag} step ${i}: ${got} instead of ${want}`);
    });
    for (const a of layout.arrows) {
      if (a.to <= a.from) wrong.push(`${tag}: an arrow goes up`);
      if ((a.to === a.from + 1) !== (a.lane === null)) wrong.push(`${tag}: ${a.from}>${a.to} straight/lane mismatch`);
      for (const [x, y] of a.points) if (x < 0 || y < 0 || x > layout.width || y > layout.height) wrong.push(`${tag}: a corner outside the picture`);
      if (a.label && a.label.x + 26 > layout.width) wrong.push(`${tag}: a word outside the picture`);
      if (a.label && a.lane !== null && a.label.x + 26 >= BOX_WIDTH + 4 + LANE_WIDTH) wrong.push(`${tag}: a word reaches the first lane`);
    }
    const laned = layout.arrows.filter((a) => a.lane !== null);
    for (const a of laned)
      for (const b of laned)
        if (a !== b && a.lane === b.lane && a.from <= b.to && b.from <= a.to) wrong.push(`${tag}: ${a.from}>${a.to} and ${b.from}>${b.to} share lane ${a.lane}`);
    for (const a of layout.arrows) {
      if (!a.label) continue;
      for (const b of layout.arrows) {
        if (b === a) continue;
        if (segs(b.points).some((s) => hits(s, a.label!.x, a.label!.y))) wrong.push(`${tag}: "${a.label.text}" of ${a.from}>${a.to} is written over ${b.from}>${b.to}`);
      }
      for (const box of layout.boxes) if (a.label.x < box.x + box.w && a.label.x + 26 > box.x && a.label.y > box.y && a.label.y - 10 < box.y + box.h) wrong.push(`${tag}: a word over a box`);
    }
    for (const box of layout.boxes) {
      const leaving = laned.filter((a) => a.from === box.index).map((a) => a.points[0][1]);
      const coming = laned.filter((a) => a.to === box.index).map((a) => a.points[3][1]);
      if (leaving.some((y) => coming.includes(y))) wrong.push(`${tag}: box ${box.index} has an arrow in and out at the same height`);
      if (new Set(leaving).size !== leaving.length) wrong.push(`${tag}: two arrows leave box ${box.index} on the same line`);
      if ([...leaving, ...coming].some((y) => y <= box.y || y >= box.y + box.h)) wrong.push(`${tag}: a side arrow misses box ${box.index}`);
    }
    const last = layout.boxes[layout.boxes.length - 1];
    if (!last.end || last.y + last.h > layout.height) wrong.push(`${tag}: the end is not the last box inside the picture`);
    if (flowRoutes(steps).length !== layout.arrows.length) wrong.push(`${tag}: routes and arrows differ`);
  }
  is("every generated workflow is drawn as the job runs it, with nothing written over a line", wrong.slice(0, 5), []);
}

part("The picture in the studio");
{
  const tagged2 = { if: "tagged", tag: "vip" } as unknown as StepCondition;
  const steps = [{ id: "a", subject: "Welcome" }, { id: "b", when: tagged2, otherwise: "jump" as const, jump: "d", subject: "VIP only" }, { id: "c", subject: "Everyone else" }, { id: "d", subject: "Last one" }];
  const html = renderToStaticMarkup(createElement(WorkflowMap, { steps, conditionText: () => "they have the label \u201cvip\u201d" }));
  const figure = html.match(/<figure[^>]*>/)?.[0] ?? "";
  const titleId = html.match(/<title id="([^"]+)"/)?.[1] ?? "none";
  is("its scroll box takes focus and is named by the picture's title (2.1.1)", [figure.includes('tabindex="0"'), figure.includes(`aria-labelledby="${titleId}"`), figure.includes("focus-visible:")], [true, true, true]);
  const decode = (t: string) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
  const boxes = [...html.matchAll(/<g[^>]*>(?:<rect[^>]*><\/rect>)((?:<text[^>]*>[^<]*<\/text>)+)<\/g>/g)].map((m) => decode([...m[1].matchAll(/>([^<]*)</g)].map((t) => t[1]).filter(Boolean).join(" ")));
  const items = [...html.matchAll(/<li[^>]*><span[^>]*>(\d+)\.<\/span><span>([^<]*)<\/span>/g)].map((m) => decode(`${m[1]}. ${m[2]}`));
  is("each box says what its line in the list says", [boxes.slice(0, steps.length), boxes.length], [items, steps.length + 1]);
}

done();
