import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentOfBranch, conflicts, lanePrefixes, reservations } from "../scripts/reservation-check.mjs";

const dense = (file: string) => readFileSync(file, "utf8").split(/\r?\n/).filter(line => line.trim()).join("\n");
const lanes = dense("docs/reservations.md");
const codex = dense("docs/reservations/codex.md");
const originalLanes = lanePrefixes(lanes);
const originalReservations = reservations(codex);
const variants = [["", "\n"], [" \t ", "\n"], ["", "\r\n"], ["\t", "\r\n"]] as const;
const spaced = (text: string, blank: string, newline: string) => text.split("\n")
  .flatMap(line => line.trim().startsWith("|") ? [line, blank] : [line]).join(newline);

test("every real lane survives blanks even between its header and separator", () => {
  assert.equal(originalLanes.length, 5);
  for (const [blank, newline] of variants) {
    const actual = lanePrefixes(spaced(lanes, blank, newline));
    assert.deepEqual(actual, originalLanes);
    assert.equal(agentOfBranch("claude3/review", actual), "claude 3");
    assert.equal(agentOfBranch("codex/j-review", actual), "codex");
  }
});

test("the last real Codex reservation remains a conflict after blanks throughout the actual table", () => {
  assert.ok(originalReservations.length > 100, "exercise the real multi-file inventory");
  const target = originalReservations.at(-1)?.file;
  assert.ok(target);
  for (const [blank, newline] of variants) {
    const text = spaced(codex, blank, newline);
    assert.deepEqual(reservations(text), originalReservations);
    const result = conflicts({ text: lanes, branch: "claude3/review", changed: [target],
      agentFiles: [{ path: "docs/reservations/codex.md", text }] });
    assert.equal(result.me, "claude 3");
    assert.equal(result.found.some((row: { file: string }) => row.file === target), true);
  }
});

test("a later paragraph or heading still stops the real table before foreign rows", () => {
  for (const boundary of ["## A later section", "A paragraph outside the table.", "### A nested section"]) {
    const text = `${codex}\n\n${boundary}\n\n| Codex | unrelated | codex/unrelated | \`lib/unrelated-review-only.ts\` | 05/11/2026 |`;
    assert.deepEqual(reservations(text), originalReservations);
  }
});
