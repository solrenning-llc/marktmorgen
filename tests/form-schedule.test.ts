/**
 * 639 [GL7](26) unit 1: a form that opens and closes at times the creator
 * sets. Before and after, the page says so in the store's language instead
 * of asking, and the answers route takes nothing.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { LATEST_SCHEDULE, formOpen, parseForm, scheduleWhen, type FormDef } from "@/lib/forms";
import { FORM_WORDS } from "@/lib/buyer-words/form";
import { BlockView, type BlockContext } from "@/components/sales-blocks";
import { readResponses } from "@/lib/form-store";
import { claimHandle, ensureStatsId, setSitePages, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as saveForms } from "@/app/api/store/forms/route";
import { POST as sendForm } from "@/app/api/store/form/route";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const NOW = 1_790_000_000;
const base = { id: "frm0000001", name: "Application", fields: [{ id: "aaaaaa", type: "email", label: "Your email", required: true, options: [] }], button: "", doneHeading: "", doneBody: "", outcomes: [], offerList: false, updatedAt: 1 };

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("The window");
  is("no times: always open", formOpen({}, NOW), "open");
  is("before it opens", formOpen({ opensAt: NOW + 60 }, NOW), "not_yet");
  is("from the moment it opens", formOpen({ opensAt: NOW }, NOW), "open");
  is("until the moment it closes", [formOpen({ closesAt: NOW + 1 }, NOW), formOpen({ closesAt: NOW }, NOW)], ["open", "ended"]);

  part("As it is kept");
  const kept = parseForm({ ...base, opensAt: NOW, closesAt: NOW + 3600 })!;
  is("both times kept", [kept.opensAt, kept.closesAt], [NOW, NOW + 3600]);
  is("a close not after the opening is let go", parseForm({ ...base, opensAt: NOW, closesAt: NOW })!.closesAt, undefined);
  is("only whole seconds, above zero, up to the end of 2100", [parseForm({ ...base, opensAt: 1.5 })!.opensAt, parseForm({ ...base, opensAt: -3 })!.opensAt, parseForm({ ...base, opensAt: LATEST_SCHEDULE + 1 })!.opensAt, parseForm({ ...base, opensAt: "soon" })!.opensAt], [undefined, undefined, undefined, undefined]);
  is("a form without times is as it was", "opensAt" in parseForm(base)! || "closesAt" in parseForm(base)!, false);

  part("Said in every language of the store");
  is("each language says both, in its own words", Object.entries(FORM_WORDS).map(([lang, w]) => [lang, typeof w.notYet("x") === "string" && w.ended.length > 10 && (lang === "en" || (w.ended !== FORM_WORDS.en.ended && w.notYet("x") !== FORM_WORDS.en.notYet("x")))]), Object.keys(FORM_WORDS).map((lang) => [lang, true]));
  is("the time in UTC, said so", scheduleWhen(Date.UTC(2026, 10, 10, 14, 0) / 1000, "en"), "November 10, 2026 at 2:00 PM UTC");
  is("in the store's language", scheduleWhen(Date.UTC(2026, 10, 10, 14, 0) / 1000, "de").includes("November 2026"), true);

  part("On the page");
  const form = parseForm({ ...base, opensAt: NOW + 86_400 }) as FormDef;
  const ctx = (now: number | undefined): BlockContext => ({ storeName: "Shop", productTitle: "", picture: null, photo: null, action: { kind: "none" } as never, defaultLabel: "", now, lang: "en", forms: { [form.id]: form } });
  const block = { id: "blk001", kind: "form" as const, heading: "Apply", form: form.id };
  const before = renderToStaticMarkup(createElement(BlockView, { block: block as never, ctx: ctx(NOW), reviews: null }));
  is("before it opens: the heading and when it opens, no questions, nothing to send", before.includes("Apply") && before.includes(`This form opens on ${scheduleWhen(NOW + 86_400, "en")}.`) && !before.includes("<form") && /role="status"/.test(before), true);
  const after = renderToStaticMarkup(createElement(BlockView, { block: block as never, ctx: { ...ctx(NOW), forms: { [form.id]: { ...form, opensAt: undefined, closesAt: NOW - 1 } } }, reviews: null }));
  is("after it closes: says so, nothing to send", after.includes(FORM_WORDS.en.ended) && !after.includes("<form"), true);
  const open = renderToStaticMarkup(createElement(BlockView, { block: block as never, ctx: ctx(NOW + 86_400), reviews: null }));
  is("while open: the questions", open.includes("<form") && open.includes("Your email"), true);
  const preview = renderToStaticMarkup(createElement(BlockView, { block: block as never, ctx: { ...ctx(undefined), preview: true }, reviews: null }));
  is("the studio's preview always shows the questions", preview.includes("<form"), true);

  part("The answers route takes nothing outside the window");
  const OWNER = "schedule@example.com";
  await claimHandle(OWNER, "scheduleshop", "Schedule Shop", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const save = async (body: unknown) => (await (await saveForms(new NextRequest("https://marktmorgen.com/api/store/forms", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ form: body }) }))).json()) as { form: FormDef };
  const later = Math.floor(Date.now() / 1000) + 86_400;
  const saved = (await save({ ...base, id: undefined, opensAt: later })).form;
  is("saved with its opening time", saved.opensAt, later);
  await setSitePages(OWNER, [{ id: "pagepage01", slug: "apply", title: "Apply", nav: false, target: "", from: 0 }]);
  const store = (await storeForEmail(OWNER))!;
  await writePage(store.statsId!, siteKey("pagepage01"), { ...parsePage({}), blocks: [{ id: "blk001", kind: "form", heading: "", form: saved.id }] } as never, ROOM);
  const post = () => sendForm(new NextRequest("https://marktmorgen.com/api/store/form", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" }, body: new URLSearchParams([["handle", "scheduleshop"], ["form", saved.id], ["page", "pagepage01"], ["q_aaaaaa", "b@example.com"]]) }));
  const refused = await post();
  is("before it opens: sent back with closed, nothing kept", [refused.headers.get("location")?.includes("status=closed"), (await readResponses(store.statsId, saved.id)).responses.length], [true, 0]);
  const reopened = (await save({ ...saved, opensAt: undefined })).form;
  is("once open, taken", [reopened.opensAt, (await post()).headers.get("location")?.includes("status=closed"), (await readResponses(store.statsId, saved.id)).responses.length], [undefined, false, 1]);

  part("In the studio");
  const editor = readFileSync("components/forms-editor.tsx", "utf8");
  is("two times, in the creator's own zone, in a named group with its help", editor.includes('<legend className="field-label">When it takes answers (optional)</legend>') && (editor.match(/type="datetime-local"/g) ?? []).length === 2 && editor.includes("In your own time zone."), true);
  is("a close before the opening is warned about", editor.includes("It closes before it opens, so the closing time will not be kept."), true);
  is("switching a quiz's scoring keeps the times", editor.includes("...(d.opensAt ? { opensAt: d.opensAt } : {}), ...(d.closesAt ? { closesAt: d.closesAt } : {}),"), true);

  done();
}

void main();
