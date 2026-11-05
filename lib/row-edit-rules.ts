/**
 * Changing a row of columns in the studio (lib/sales-page.ts, RowBlock;
 * queue item 375 [TB1], unit 2): how many columns, adding, moving and
 * removing a column's elements, and what an element still needs before the
 * page can be saved. Pure and browser-safe, so the editor
 * (components/page-editor.tsx, RowEditor) and the tests use the same rules.
 *
 * Every change returns new arrays and leaves the row it was given as it was;
 * an element that does not change is the same object, so the editor's undo
 * holds each step whole. A change that would break a limit is refused with a
 * reason the editor says beside the control, and nothing is ever dropped:
 * fewer columns move the removed columns' elements to the end of the last
 * column that stays, or the change is refused.
 */
import {
  MAX_COLUMN_ELEMENTS,
  MAX_ITEM,
  MAX_ROW_COLUMNS,
  MAX_ROW_ELEMENTS,
  MAX_ROW_LIST_ITEMS,
  MIN_ROW_COLUMNS,
  type RowElement,
  type RowElementKind,
  type RowIcon,
  quoteUrl,
} from "@/lib/sales-page";

export type RowColumns = readonly (readonly RowElement[])[];

/** Where an element is: its column and its place in it, both counted from 0. */
export type RowPlace = { column: number; index: number };

export type RowRefusal = "columns" | "column_full" | "row_full" | "fewer_full" | "sending" | "edge" | "same_column" | "missing";

/**
 * The places held in each column, by position, for pictures still being
 * sent there: a held place counts as a part, so nothing takes it before the
 * picture arrives and the file sent always has a part to show it. Absent or
 * shorter than the row means nothing held.
 */
export type RowHeld = readonly number[];

const heldIn = (held: RowHeld, column: number) => Math.max(0, held[column] ?? 0);
const heldAll = (held: RowHeld) => held.reduce((n, count) => n + Math.max(0, count), 0);

/**
 * The held places after one picture field's count in a column changed by `by`
 * (its new count less the one it said before). Added to what is held, never
 * written over it: a send begun before the row was closed and reopened keeps
 * its place while the reopened row starts another. Never below zero.
 */
export function shiftHeld(held: RowHeld, column: number, by: number): number[] {
  return held.map((count, i) => (i === column ? Math.max(0, count + by) : count));
}

/** The places held with one fewer in `column`: what a picture that has arrived takes its own place from. */
export function releaseHeld(held: RowHeld, column: number): number[] {
  return held.map((count, i) => (i === column ? Math.max(0, count - 1) : count));
}

/**
 * A picture that finished sending, added to the row as it is now: checked
 * against it, with the picture's own held place given back (`places` is the
 * held places without it, releaseHeld). Pure, so the page editor can apply it
 * as an update of its current state, whatever changed while it was sent.
 */
export function arrivePicture(now: RowColumns, column: number, element: RowElement, places: readonly number[]): RowEdit {
  const refused = addRefusal(now, column, places);
  if (refused) return { ok: false, why: refused };
  return addElement(now, column, element, places);
}

/** A change made, with where the element it concerns now is (null when it is gone), or refused with why. */
export type RowEdit = { ok: true; columns: RowElement[][]; at: RowPlace | null } | { ok: false; why: RowRefusal };

/** What each refusal says beside the control, in plain words. */
export const ROW_EDIT_WHY: Record<RowRefusal, string> = {
  columns: `A row has ${MIN_ROW_COLUMNS} to ${MAX_ROW_COLUMNS} columns.`,
  column_full: `This column is full: a column holds up to ${MAX_COLUMN_ELEMENTS} parts. Remove one, or use another column.`,
  row_full: `This row is full: a row holds up to ${MAX_ROW_ELEMENTS} parts in all its columns. Remove one first.`,
  fewer_full: `Fewer columns would put more than ${MAX_COLUMN_ELEMENTS} parts in the last column, so nothing changed. Remove some parts first.`,
  sending: "A picture is still being sent to a column that would be taken away. Wait until it arrives, then change the columns.",
  edge: "It is already at that end of its column.",
  same_column: "It is already in that column.",
  missing: "That part is no longer there.",
};

/** What each kind of element is called in the studio. */
export const ROW_ELEMENT_NAMES: Record<RowElementKind, string> = {
  heading: "Heading",
  subheading: "Smaller heading",
  paragraph: "Words",
  list: "List",
  icon: "Icon",
  button: "Button",
  image: "Picture",
  video: "Video",
};

/** Each icon's name as a person reads it. */
export const ROW_ICON_NAMES: Record<RowIcon, string> = {
  check: "Check mark",
  "check-circle": "Check mark in a circle",
  star: "Star",
  shield: "Shield",
  gift: "Gift",
  clock: "Clock",
  calendar: "Calendar",
  book: "Book",
  chat: "Speech bubble",
  target: "Target",
  bolt: "Lightning bolt",
  sparkle: "Sparkle",
  lock: "Lock",
  globe: "Globe",
  user: "One person",
  users: "Group of people",
  mail: "Envelope",
  phone: "Phone",
  play: "Play button",
  video: "Video camera",
  camera: "Camera",
  music: "Musical note",
  mic: "Microphone",
  cap: "Graduation cap",
  chart: "Chart",
  key: "Key",
  pin: "Map pin",
  download: "Download arrow",
  info: "Information sign",
};

const copy = (columns: RowColumns): RowElement[][] => columns.map((column) => [...column]);
const valid = (columns: RowColumns) => columns.length >= MIN_ROW_COLUMNS && columns.length <= MAX_ROW_COLUMNS;
const has = (columns: RowColumns, at: RowPlace) => at.column >= 0 && at.column < columns.length && at.index >= 0 && at.index < columns[at.column].length;

/** How many elements the whole row holds. */
export function rowElementCount(columns: RowColumns): number {
  return columns.reduce((n, column) => n + column.length, 0);
}

/** Why nothing more can be added to this column now, or null when something can. */
export function addRefusal(columns: RowColumns, column: number, held: RowHeld = []): RowRefusal | null {
  if (column < 0 || column >= columns.length) return "missing";
  if (rowElementCount(columns) + heldAll(held) >= MAX_ROW_ELEMENTS) return "row_full";
  if (columns[column].length + heldIn(held, column) >= MAX_COLUMN_ELEMENTS) return "column_full";
  return null;
}

/**
 * The row with `count` columns. More columns are added empty at the end.
 * Fewer columns move every element of the columns taken away, in their
 * order, to the end of the last column that stays; refused when that column
 * would then hold more than a column may, its held places counted, or while
 * a picture is on its way to a column taken away. The row's total never
 * changes.
 */
export function setColumnCount(columns: RowColumns, count: number, held: RowHeld = []): RowEdit {
  if (!Number.isInteger(count) || count < MIN_ROW_COLUMNS || count > MAX_ROW_COLUMNS || !valid(columns)) return { ok: false, why: "columns" };
  if (count === columns.length) return { ok: true, columns: copy(columns), at: null };
  if (count > columns.length) return { ok: true, columns: [...copy(columns), ...Array.from({ length: count - columns.length }, () => [])], at: null };
  if (columns.some((_, i) => i >= count && heldIn(held, i) > 0)) return { ok: false, why: "sending" };
  const kept = copy(columns.slice(0, count));
  const moved = columns.slice(count).flat();
  const last = [...kept[count - 1], ...moved];
  if (last.length + heldIn(held, count - 1) > MAX_COLUMN_ELEMENTS) return { ok: false, why: "fewer_full" };
  kept[count - 1] = last;
  return { ok: true, columns: kept, at: null };
}

/** The row with `element` at the end of `column`; `at` is where it went. */
export function addElement(columns: RowColumns, column: number, element: RowElement, held: RowHeld = []): RowEdit {
  const why = addRefusal(columns, column, held);
  if (why) return { ok: false, why };
  const out = copy(columns);
  out[column].push(element);
  return { ok: true, columns: out, at: { column, index: out[column].length - 1 } };
}

/**
 * The row with one element moved: one place up or down in its column, or
 * to the end of another column. `at` is where it is now. Moving to another
 * column is refused when that column is full, its held places counted; the
 * row's total never changes.
 */
export function moveElement(columns: RowColumns, from: RowPlace, to: "up" | "down" | { column: number }, held: RowHeld = []): RowEdit {
  if (!has(columns, from)) return { ok: false, why: "missing" };
  const out = copy(columns);
  if (to === "up" || to === "down") {
    const index = from.index + (to === "up" ? -1 : 1);
    if (index < 0 || index >= out[from.column].length) return { ok: false, why: "edge" };
    const column = out[from.column];
    [column[from.index], column[index]] = [column[index], column[from.index]];
    return { ok: true, columns: out, at: { column: from.column, index } };
  }
  if (to.column < 0 || to.column >= out.length) return { ok: false, why: "missing" };
  if (to.column === from.column) return { ok: false, why: "same_column" };
  if (out[to.column].length + heldIn(held, to.column) >= MAX_COLUMN_ELEMENTS) return { ok: false, why: "column_full" };
  const [element] = out[from.column].splice(from.index, 1);
  out[to.column].push(element);
  return { ok: true, columns: out, at: { column: to.column, index: out[to.column].length - 1 } };
}

/**
 * The row without one element. `at` is where focus goes next: the element
 * that took its place, or else the one before it, or null when the column
 * is now empty (the editor then goes to the column's Add control).
 */
export function removeElement(columns: RowColumns, place: RowPlace): RowEdit & { removed?: RowElement } {
  if (!has(columns, place)) return { ok: false, why: "missing" };
  const out = copy(columns);
  const [removed] = out[place.column].splice(place.index, 1);
  const left = out[place.column].length;
  const at = left === 0 ? null : { column: place.column, index: Math.min(place.index, left - 1) };
  return { ok: true, columns: out, at, removed };
}

/** The row with one element replaced by `element`. */
export function replaceElement(columns: RowColumns, place: RowPlace, element: RowElement): RowEdit {
  if (!has(columns, place)) return { ok: false, why: "missing" };
  const out = copy(columns);
  out[place.column][place.index] = element;
  return { ok: true, columns: out, at: place };
}

/**
 * A new element of a kind that starts empty, for the creator to fill in.
 * A picture and a video start from what was chosen, so they are made where
 * the picture is sent or the address is recognized: null here.
 */
export function blankElement(kind: RowElementKind): RowElement | null {
  switch (kind) {
    case "heading":
    case "subheading":
    case "paragraph":
      return { kind, text: "" };
    case "list":
      return { kind, items: [] };
    case "icon":
      return { kind, name: "check", label: "" };
    case "button":
      return { kind, label: "", url: "" };
    default:
      return null;
  }
}

/** One line as the page's own reading makes it (lib/sales-page.ts, line): control characters and runs of space made one space, trimmed. */
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();

/** Whether text holds anything once spaces and control characters are taken out, as the page's own reading does. */
const hasWords = (text: string) => /[^\s\u0000-\u001f\u007f\u2028\u2029]/.test(text);

/**
 * What one element still needs before the page can be saved, in plain
 * words, or null when it is ready: the same rules the save route holds it
 * to (lib/sales-page.ts, parseRowElement and the "row" problem), said where
 * the creator types, before saving.
 */
export function rowElementProblem(element: RowElement): string | null {
  switch (element.kind) {
    case "heading":
    case "subheading":
      return hasWords(element.text) ? null : `Write the ${element.kind === "heading" ? "heading" : "smaller heading"}, or remove this part.`;
    case "paragraph":
      return hasWords(element.text) ? null : "Write the words, or remove this part.";
    case "list": {
      // Empty lines are left out before points are counted, as the page's own reading does.
      const points = element.items.map(oneLine).filter(Boolean);
      if (points.length > MAX_ROW_LIST_ITEMS) return `A list holds up to ${MAX_ROW_LIST_ITEMS} points, one on each line. This one has ${points.length}: remove the extra points.`;
      const long = points.findIndex((point) => point.length > MAX_ITEM);
      if (long >= 0) return `A point holds up to ${MAX_ITEM} characters. Point ${long + 1} has ${points[long].length}: shorten it.`;
      return points.length ? null : "Write at least one point, one on each line, or remove this part.";
    }
    case "button": {
      if (!element.url.trim()) return null;
      if (!quoteUrl(element.url)) return "That is not a full https address of a public page. Fix it, or leave it empty so the button goes to this page's checkout.";
      return hasWords(element.label) ? null : "A button that goes elsewhere needs its own words, so visitors know where it leads.";
    }
    case "image":
      return element.decorative || hasWords(element.picture.alt) ? null : "Say what the picture shows, for someone who cannot see it, or mark it as decoration.";
    case "icon":
    case "video":
      return null;
  }
}

/** The first element of a row that still needs something, with where it is, or null when the whole row is ready. */
export function rowProblem(columns: RowColumns): (RowPlace & { problem: string }) | null {
  for (let column = 0; column < columns.length; column += 1) {
    for (let index = 0; index < columns[column].length; index += 1) {
      const problem = rowElementProblem(columns[column][index]);
      if (problem) return { column, index, problem };
    }
  }
  return null;
}
