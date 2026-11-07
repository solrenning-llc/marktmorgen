/**
 * Completeness complements in docs/codex-queue.md point at other lines of the
 * queue by quoted text, never by line number (review of #2708, Claude 4,
 * comment 6696300010). The queue grows with every pull request, so a number
 * that was right at the audited commit is wrong at the next one: the
 * complement for 232 [CA1] cited "queue.md:5979", "linha 5971" and
 * "linha 6020", which had already moved to 5992, 5984 and 6033. Checked:
 * no complement cites a line number of the queue itself (a line number of
 * another file, named right before it, stays allowed), and every line a
 * complement quotes as "a linha '…'" or "da linha '…'" exists in the queue.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const queue = readFileSync("docs/codex-queue.md", "utf8");
const lines = queue.split("\n");
const complements = lines.filter(l => l.includes("Complemento de completude ("));
const rest = lines.filter(l => !l.includes("Complemento de completude (")).join("\n");

const FILE = /[\w./-]+\.(?:md|ts|tsx|mjs|js|json|yml|yaml|py)\b/g;

/** Line numbers a complement gives for the queue itself. */
function queueLineNumbers(line: string): string[] {
  const found: string[] = [];
  for (const m of line.matchAll(/(?:codex-)?queue\.md:\d+/g)) found.push(m[0]);
  for (const m of line.matchAll(/\blinhas? \d+/g)) {
    const before = line.slice(0, m.index);
    const files = [...before.matchAll(FILE)].map(f => f[0]);
    const last = files[files.length - 1] ?? "";
    if (last.endsWith("queue.md")) found.push(m[0]);
  }
  return found;
}

part("Complements cite queue lines by text, not by number");
is("there are completeness complements to check", complements.length > 0, true);
is("no complement gives a line number of the queue itself",
  complements.flatMap(l => queueLineNumbers(l).map(n => `${n} in: ${l.slice(0, 90)}`)), []);
is("a number for another file, named before it, is allowed",
  queueLineNumbers("atualizar docs/backup.md, cuja linha 11 diz; em lib/help-content.ts (linhas 331-334)"), []);
is("a queue number after the queue's path is caught",
  queueLineNumbers("atualizar em docs/codex-queue.md a linha 5971 e a linha 6020; queue.md:5979"),
  ["queue.md:5979", "linha 5971", "linha 6020"]);

part("Every queue line a complement quotes exists");
const quoted = complements.flatMap(l => [...l.matchAll(/\b(?:a|da|na) linha '([^']+)'/g)].map(m => m[1]));
is("each quoted line is found once in the queue, outside the complements",
  quoted.filter(q => rest.split(q).length !== 2), []);

done();
