/**
 * AX274 (3.1.5 Reading Level), for three public pages the earlier units did
 * not reach: /help/zoom, the reasons on /platform and /status. On 13 November
 * 2026, Chromium read four sentences of 39 to 43 words on them.
 * Each is split, saying the same things.
 *
 * What must hold: in the page's source text, none of these four sentences is
 * 35 words or more.
 */
import { readFileSync } from "node:fs";
import { HOME_REASONS } from "@/lib/home-reasons";
import { done, is, part } from "./check";

const LIMIT = 35;
const words = (s: string) => s.match(/[A-Za-z']+/g)?.length ?? 0;
const flat = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/<[^>]+>/g, "")
    .replace(/\{" "\}/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/\s+/g, " ");

function sentence(text: string, start: string): string | null {
  const at = text.indexOf(start);
  if (at < 0) return null;
  const rest = text.slice(at);
  const end = rest.search(/[.!?](?=[\s"]|$)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

const reasons = JSON.stringify(HOME_REASONS);
const cases: [string, string, string][] = [
  ["/help/zoom", flat("app/help/zoom/page.tsx"), "Each booking of a one-to-one call"],
  ["/help/zoom", flat("app/help/zoom/page.tsx"), "Start in Zoom next to a call"],
  ["/platform", reasons, "A buyer on a new phone types the email address"],
  ["/status", flat("app/status/page.tsx"), "It checks that each service reports a bounce"],
];

part(`each sentence is under ${LIMIT} words`);
for (const [page, text, start] of cases) {
  const s = sentence(text, start);
  is(`${page}: "${start}…" (now ${s === null ? "not found" : words(s)} words)`, s !== null && words(s) < LIMIT, true);
}
done();
