/**
 * 274 [AX1] Part A item 6, a sales page's buttons (WCAG 2.4.4, 2.4.9): the
 * page coach (lib/page-coach.ts) checks that each button's own words say what it
 * does, on both versions of the page, sharing the rule of the store's links
 * (lib/link-purpose.ts). An empty label keeps the page's own words, which do.
 *
 * What fails here: a "Click here" button not counted; a clear or empty one
 * counted; the second version left out; the check shown on a page with no
 * button; the rule not shared with the store's links.
 */
import { readFileSync } from "node:fs";
import { coachChecks, type CoachInput } from "@/lib/page-coach";
import { vagueLinkTitle } from "@/lib/link-purpose";
import { vagueLinkTitle as storeRule } from "@/lib/store-access-check";
import { done, is, part } from "./check";

const cta = (id: string, label: string) => ({ id, kind: "cta" as const, label, note: "" });
const input = (blocks: CoachInput["page"]["blocks"], variant?: CoachInput["page"]["blocks"]): CoachInput => ({
  page: { blocks, seoDescription: "", test: null, ...(variant ? { variant: { blocks: variant } as never } : {}) },
  productTitle: "Bread basics",
  free: false,
  picture: false,
  pictureAlt: "",
  facts: {},
});
const check = (i: CoachInput) => coachChecks(i).find((c) => c.id === "button_words");

part("Each button's words say what it does");
is("no button on the page: no such check", check(input([])), undefined);
is("a clear button and an empty one (the page's own words): done", [check(input([cta("cta00001", "Get the course"), cta("cta00002", "")]))?.done, check(input([cta("cta00001", "Get the course"), cta("cta00002", "")]))?.label], [true, "Every button says what it does"]);
is("a \"Click here\" button: counted", [check(input([cta("cta00001", "Click here"), cta("cta00002", "Get the course")]))?.done, check(input([cta("cta00001", "Click here")]))?.label], [false, "Every button says what it does (1 does not)"]);
is("the second version is read too", check(input([cta("cta00001", "Get the course")], [cta("cta00003", "Read more"), cta("cta00004", "Here")]))?.label, "Every button says what it does (2 do not)");
is("why it matters, with examples", /Get the course/.test(check(input([cta("cta00001", "Click here")]))?.why ?? ""), true);

part("One rule for the store's links and the page's buttons");
is("the store's check is the same function", storeRule, vagueLinkTitle);
is("the coach reads it from the shared, browser-safe module", /from "@\/lib\/link-purpose"/.test(readFileSync("lib/page-coach.ts", "utf8")) && !/from "@\/lib\/catalog"/.test(readFileSync("lib/link-purpose.ts", "utf8")), true);
done();
