/**
 * The picture of a workflow (391 [CX2], unit 1; added 12 November 2026):
 * boxes for its steps, top to bottom, and arrows for where each one leads,
 * with the "if yes" and "if not" of a condition each on its own arrow.
 *
 * It is drawn from the same routing the scheduled job runs (afterIndex and
 * elseIndex in lib/flow-paths.ts), so the picture cannot say one thing and
 * the job do another: a target that is gone or behind ends the run in both.
 * Routes only point forward (checkRoutes), so every arrow goes down the page
 * and the picture has no loops to untangle.
 *
 *   - An arrow to the very next box is drawn straight down between the two.
 *   - An arrow that passes over boxes, or goes to the end from a box that is
 *     not the last, runs down a lane to the right of the boxes. Lanes are
 *     shared only by arrows whose stretches do not touch, so no two arrows
 *     run down on top of each other. Side arrows leave a box from its
 *     middle and come into a box near its bottom, so one coming in never
 *     runs along one going out; the only lines that share a stretch are
 *     arrows coming into the same box, which all mean the same thing.
 *   - The two arrows of a condition say "Yes" and "No" in words, and "No" is
 *     also dashed, so neither is told apart by colour alone. When both lead
 *     to the same box (the step is only skipped), there is one arrow.
 *
 * The words in a box are wrapped, never cut: a long subject makes a taller
 * box. The list of steps under the picture stays the complete alternative for
 * keyboards and screen readers; the picture adds nothing the list lacks.
 *
 * Browser-safe: plain data and pure functions, no measuring of the page.
 */
import { type RoutedStep, afterIndex, elseIndex } from "@/lib/flow-paths";

/** The width of a step's box, in the picture's own units (CSS pixels at 100%). */
export const BOX_WIDTH = 300;
/** The most characters on one line of a box: wide enough for 300 units at 14px with room to spare. */
export const LINE_CHARS = 32;
/** The height of one line of words in a box. */
export const LINE_HEIGHT = 20;
const PAD_Y = 14;
/** The room between two boxes, for the arrow and its word. */
export const GAP = 44;
/** The room each lane to the right of the boxes takes. */
export const LANE_WIDTH = 32;
const MARGIN = 4;
/** How far above or below the middle of a box its "Yes" and "No" side arrows leave, so they do not start on top of each other. */
const SPLIT = 8;
/** How far above a box's bottom edge side arrows come in: below where its own side arrows leave, so an arrival never runs along a departure. */
const ARRIVE = 8;

export type ArrowKind = "then" | "yes" | "no";

export type MapBox = {
  /** The step's place in the list; steps.length for the end. */
  index: number;
  end: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
};

export type MapArrow = {
  from: number;
  /** The box it points at: a step's index, or steps.length for the end. */
  to: number;
  kind: ArrowKind;
  /** The corners of its line, first to last; the last is where the arrowhead is. */
  points: [number, number][];
  /** The word on it, "Yes" or "No", and where it is written; null for a plain "then". */
  label: { text: "Yes" | "No"; x: number; y: number } | null;
  /** The lane it runs down, counted from 0; null when it goes straight down. */
  lane: number | null;
};

export type FlowMapLayout = { width: number; height: number; boxes: MapBox[]; arrows: MapArrow[]; lanes: number };

/**
 * Words broken into lines of at most `max` characters, at spaces where it can
 * and inside a word only when the word alone is longer than a line. Nothing is
 * dropped: joining the lines gives back every character but the spaces broken at.
 */
export function wrapWords(text: string, max = LINE_CHARS): string[] {
  const lines: string[] = [];
  let line = "";
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    let word = [...raw];
    while (word.length > max) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(word.slice(0, max).join(""));
      word = word.slice(max);
    }
    const piece = word.join("");
    if (!piece) continue;
    if (!line) line = piece;
    else if ([...line].length + 1 + word.length <= max) line = `${line} ${piece}`;
    else {
      lines.push(line);
      line = piece;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

type Route = { from: number; to: number; kind: ArrowKind };

/** Every route of every step, the end written as steps.length; one route when both answers lead to the same box. */
export function flowRoutes(steps: readonly RoutedStep[]): Route[] {
  const end = steps.length;
  const at = (j: number) => (j < 0 ? end : j);
  const routes: Route[] = [];
  steps.forEach((step, i) => {
    const yes = at(afterIndex(steps, i));
    if (!step.when) {
      routes.push({ from: i, to: yes, kind: "then" });
      return;
    }
    const no = at(elseIndex(steps, i));
    if (yes === no) routes.push({ from: i, to: yes, kind: "then" });
    else routes.push({ from: i, to: yes, kind: "yes" }, { from: i, to: no, kind: "no" });
  });
  return routes;
}

/**
 * The whole picture: boxes stacked in list order with the end below them,
 * and every arrow with its corners. `labels[i]` is what box i says.
 */
export function flowMapLayout(steps: readonly RoutedStep[], labels: readonly string[]): FlowMapLayout {
  const boxes: MapBox[] = [];
  let y = MARGIN;
  for (let i = 0; i <= steps.length; i += 1) {
    const end = i === steps.length;
    const lines = end ? ["End"] : wrapWords(labels[i] ?? "");
    const h = lines.length * LINE_HEIGHT + 2 * PAD_Y;
    boxes.push({ index: i, end, x: MARGIN, y, w: BOX_WIDTH, h, lines });
    y += h + GAP;
  }
  const height = y - GAP + MARGIN;
  const right = MARGIN + BOX_WIDTH;
  const cx = MARGIN + BOX_WIDTH / 2;
  const mid = (b: MapBox) => b.y + b.h / 2;

  const routes = flowRoutes(steps);
  // Lanes: an arrow takes the first lane whose last arrow ended above where it starts.
  const side = routes.filter((r) => r.to !== r.from + 1).sort((a, b) => a.from - b.from || a.to - b.to);
  const laneEnds: number[] = [];
  const laneOf = new Map<Route, number>();
  for (const r of side) {
    let lane = laneEnds.findIndex((last) => last < r.from);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(r.to);
    } else laneEnds[lane] = r.to;
    laneOf.set(r, lane);
  }

  const arrows: MapArrow[] = routes.map((r) => {
    const from = boxes[r.from];
    const to = boxes[r.to];
    const word = r.kind === "then" ? null : r.kind === "yes" ? ("Yes" as const) : ("No" as const);
    const lane = laneOf.get(r);
    if (lane === undefined) {
      const top = from.y + from.h;
      return { from: r.from, to: r.to, kind: r.kind, lane: null, points: [[cx, top], [cx, to.y]], label: word && { text: word, x: cx + 8, y: top + GAP / 2 + 5 } };
    }
    // Both answers leave from the right side only when both pass over boxes; then they leave apart.
    const both = side.some((o) => o !== r && o.from === r.from);
    const leave = mid(from) + (both ? (r.kind === "yes" ? -SPLIT : SPLIT) : 0);
    const x = right + (lane + 1) * LANE_WIDTH;
    return {
      from: r.from,
      to: r.to,
      kind: r.kind,
      lane,
      points: [[right, leave], [x, leave], [x, to.y + to.h - ARRIVE], [right, to.y + to.h - ARRIVE]],
      // Above its own line, before the first lane: no other line passes there.
      label: word && { text: word, x: right + 3, y: leave - 3 },
    };
  });

  return { width: right + laneEnds.length * LANE_WIDTH + LANE_WIDTH / 2 + MARGIN, height, boxes, arrows, lanes: laneEnds.length };
}
