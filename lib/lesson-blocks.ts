/**
 * A lesson's text cut into what the lesson page draws (components/lesson-text.tsx):
 * paragraphs, lists and, since 2 November 2026, blocks of code (103
 * [E2-LESSON-MEDIA], unit 1). Pure and browser-safe.
 *
 *   - A block of code starts at a line that begins with three or more
 *     backticks (```), the rest of that line naming its language when it is
 *     one word, and ends at the next line of as many backticks. Everything
 *     between is kept as saved, blank lines and spaces included (saving a
 *     lesson makes three or more blank lines two, lib/course.ts), and is shown
 *     as text: nothing in it ever becomes markup. An opening line with no
 *     closing one is just text, so a stray line of backticks in a lesson never
 *     turns the rest of it into code. An empty block is not shown.
 *   - Outside code, a blank line starts a paragraph and a line starting with
 *     "- " is a point in a list, as before.
 */

export type LessonBlock =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "code"; language: string; code: string };

const LANGUAGE = /^[A-Za-z0-9+#.-]{1,20}$/;

/** A fence line: its backticks, and the language it names (empty for none or one not a single word); null for any other line. Read without a pattern that can go back over itself. */
function fence(line: string): { ticks: number; language: string } | null {
  const t = line.trim();
  if (!t.startsWith("```")) return null;
  let ticks = 0;
  while (ticks < t.length && t[ticks] === "`") ticks += 1;
  const rest = t.slice(ticks).trim();
  return { ticks, language: LANGUAGE.test(rest) ? rest : "" };
}

/** Whether a line closes a block opened with `ticks` backticks: as many backticks or more, and nothing else. */
const closes = (line: string, ticks: number) => {
  const t = line.trim();
  return t.length >= ticks && /^`+$/.test(t);
};
const BULLET = /^[-•]\s+/;

/** The text outside code, as paragraphs and lists, the way the page always read it: each blank-line block cut into runs of plain lines and of list lines. */
function prose(text: string): LessonBlock[] {
  const out: LessonBlock[] = [];
  for (const block of text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)) {
    let run: LessonBlock | null = null;
    for (const line of block.split("\n")) {
      const list = BULLET.test(line);
      if (list && run?.kind === "list") run.items.push(line.replace(BULLET, ""));
      else if (!list && run?.kind === "paragraph") run.lines.push(line);
      else {
        run = list ? { kind: "list", items: [line.replace(BULLET, "")] } : { kind: "paragraph", lines: [line] };
        out.push(run);
      }
    }
  }
  return out;
}

/** The lesson's blocks, in order. */
export function lessonBlocks(text: string): LessonBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: LessonBlock[] = [];
  let outside: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = fence(lines[i]);
    let end = -1;
    if (open) for (let j = i + 1; j < lines.length; j += 1) if (closes(lines[j], open.ticks)) { end = j; break; }
    if (!open || end < 0) {
      outside.push(lines[i]);
      continue;
    }
    out.push(...prose(outside.join("\n")));
    outside = [];
    const code = lines.slice(i + 1, end).join("\n");
    if (code.trim()) out.push({ kind: "code", language: open.language, code });
    i = end;
  }
  out.push(...prose(outside.join("\n")));
  return out;
}
