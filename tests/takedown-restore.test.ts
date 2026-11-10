/**
 * C6-92 (Claude 1, 10 November 2026): a link taken down for a copyright notice is held, not deleted, so it can be put
 * back as 17 U.S.C. § 512(g)(2)(C) provides and as the email to the creator promises ("we put the content back in
 * 10 to 14 business days"). Until then the link left the store at once and its picture file was deleted, so a valid
 * counter-notice could never be honored.
 *
 * Held: off the store page for every visitor, its picture's address answers "not found", and the picture is kept
 * under a name no page gives out, in the store's own picture folder. A counter-notice recorded within the window
 * puts back the same link (same id, title, address and place) and the same picture at the same address, with the
 * same bytes, after 12 full weekdays (at least 10 business days, even with two holidays between) and before the end
 * of the 14th. Without a counter-notice, or once the sender says they went to court, the link and its picture are
 * deleted when the window ends, as before. An unreadable hold, or a step the file store does not confirm, never puts
 * it back early, never deletes it early and never serves it. Other notices keep their rule: deleted at once.
 *
 * lib/takedown.ts, lib/takedown-hold.ts, lib/store.ts (heldLinks). Synthetic data only.
 */
import { NextRequest } from "next/server";
import { GET as servePicture } from "@/app/api/image/[folder]/[file]/route";
import { POST as act } from "@/app/api/takedown/route";
import { addStoreLink, claimHandle, closeStoreRecord, createStore, deleteStore, dropHeldLink, ensureStatsId, imageFolder, setLinkImage, storeForEmail, storeRef } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { type Report, actOnHeld, fileReport, noticeSentAt, openReport, settleHeld, takeDown } from "@/lib/takedown";
import { createHash } from "node:crypto";
import { COUNTER_NOTICE_DAYS, RESTORE_AFTER_WEEKDAYS, RESTORE_BY_WEEKDAYS, restoreFrom } from "@/lib/takedown-hold";
import { imageUrl } from "@/lib/product-image";
import { MAX_STORE_LINKS, showingLinks } from "@/lib/store-link";
import { faults, hooks, kept } from "./picture-takedown-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[] | string; subject: string; text: string };
const sent: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const OWNER = "holding@example.test";
const DAY = 86_400_000;
let serial = 0;
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");

async function fetchPicture(path: string): Promise<[number, string]> {
  const [, folder, file] = path.split("/");
  const r = await servePicture(new NextRequest(`${ORIGIN}${imageUrl({ path })}`, { headers: { "x-forwarded-for": `198.51.100.${20 + (serial++ % 200)}` } }), { params: Promise.resolve({ folder, file }) });
  return [r.status, r.status === 200 ? Buffer.from(await r.arrayBuffer()).toString("hex") : ""];
}

async function current() {
  const s = await storeForEmail(OWNER);
  if (!s) throw new Error("no store");
  return s;
}

/** A link with its own picture, the picture's bytes in the file store. */
async function pictured(title: string, n: number): Promise<{ id: string; path: string; bytes: string }> {
  const made = await addStoreLink(OWNER, title, `https://example.com/${n}`);
  if (!made.ok) throw new Error("no link");
  const id = made.store.links[made.store.links.length - 1].id;
  const path = `images/${await imageFolder(OWNER)}/${hex(n, 32)}.webp`;
  kept.set(path, new Uint8Array([0x52, 0x49, 0x46, 0x46, n, 7, 7]));
  const put = await setLinkImage(OWNER, id, { path, width: 320, height: 320, bytes: 7 });
  if (!put.ok) throw new Error("no picture");
  return { id, path, bytes: Buffer.from(kept.get(path)!).toString("hex") };
}

/** Independent of the code: the start of the 13th weekday (UTC) after the day the counter-notice came in. */
function weekdayStart(at: number, full: number): number {
  let day = Math.floor(at / DAY) * DAY;
  let counted = 0;
  while (counted < full) {
    day += DAY;
    const w = new Date(day).getUTCDay();
    if (w !== 0 && w !== 6) counted += 1;
  }
  // The next weekday after the last full one.
  do day += DAY; while ([0, 6].includes(new Date(day).getUTCDay()));
  return day;
}
const weekdaysBetween = (from: number, to: number) => {
  let n = 0;
  for (let day = Math.floor(from / DAY) * DAY + DAY; day + DAY <= to; day += DAY) if (![0, 6].includes(new Date(day).getUTCDay())) n += 1;
  return n;
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  if (!(await claimHandle(OWNER, "holdingshop", "Holding shop", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);

  const input = {
    kind: "copyright", url: `${ORIGIN}/@holdingshop`, work: "My photograph, used as this link's picture.", original: "https://example.com/photo",
    name: "Sam Sender", email: "sam@example.com", contact: "+1 555 0100", signature: "Sam Sender", goodFaith: true, accurate: true,
  };
  const read = readReport(input);
  if (!read.ok) throw new Error("notice not read");
  is("the notice is filed and sent to the inbox", await fileReport(read.report, "198.51.100.7", ORIGIN), "sent");
  const token = /\/takedown\/([0-9a-f]{48})/.exec(sent[sent.length - 1]?.text ?? "")?.[1] ?? "";
  const opened = await openReport(token);
  if (!opened) throw new Error("the notice does not open");
  const report: Report = opened.report;

  part("Window and bounds, as the code states them");
  is("a counter-notice is taken for 30 days after the takedown", COUNTER_NOTICE_DAYS, 30);
  is("put back after 12 full weekdays, by the end of the 14th", [RESTORE_AFTER_WEEKDAYS, RESTORE_BY_WEEKDAYS], [12, 14]);
  for (const at of [Date.UTC(2026, 11, 24, 15), Date.UTC(2026, 10, 13, 22), Date.UTC(2027, 5, 18, 9), Date.UTC(2026, 10, 14, 3)]) {
    const back = restoreFrom(at);
    is(`counter-notice at ${new Date(at).toISOString()}: back at the start of the 13th weekday after it`, back, weekdayStart(at, 12));
    const elapsed = weekdaysBetween(at, back);
    is("so at least 10 business days with two holidays between, and at most 14", [elapsed >= 12, elapsed <= 14], [true, true]);
  }

  part("A copyright notice holds the link: off the page, its picture gone from its address, kept");
  const first = await pictured("Photo set", 1);
  const before = await current();
  const place = before.links.findIndex((l) => l.id === first.id);
  const original = before.links[place];
  is("the control: the picture is served", (await fetchPicture(first.path))[0], 200);
  const heldAt = Date.now();
  const taken = await takeDown(report, before, { type: "link", id: first.id }, ORIGIN, token);
  is("the takedown says what went", taken, `The link "Photo set" (https://example.com/1)`);
  const held = await current();
  is("the link is off the store, for every visitor", [held.links.some((l) => l.id === first.id), showingLinks(held.links).some((l) => l.id === first.id)], [false, false]);
  is("it is held, the same link, for this notice", [held.heldLinks?.length, held.heldLinks?.[0]?.link, held.heldLinks?.[0]?.report], [1, original, report.id]);
  const until = Date.parse(held.heldLinks?.[0]?.until ?? "");
  is("held until 30 days after the takedown", until >= heldAt + 30 * DAY && until <= Date.now() + 30 * DAY, true);
  is("its picture's address answers not found", (await fetchPicture(first.path))[0], 404);
  const keptAs = held.heldLinks?.[0]?.picture ?? "";
  is("the picture is kept, with the same bytes, under another name in the store's own picture folder", [keptAs !== first.path, keptAs.slice(0, keptAs.lastIndexOf("/")), Buffer.from(kept.get(keptAs) ?? []).toString("hex")], [true, first.path.slice(0, first.path.lastIndexOf("/")), first.bytes]);
  const told = sent.filter((m) => m.subject.includes("Content taken down")).at(-1);
  is("the creator is told it is kept until a date, and what a counter-notice does", [Boolean(told?.text.includes("We keep the link and its picture")), Boolean(told?.text.includes(new Date(until).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" }))), Boolean(told?.text.includes("for good"))], [true, true, false]);
  is("the page that acts on the notice stays open until the hold and a put-back are over", (await redis.pipeline([["TTL", `nl:report:t:${(await import("node:crypto")).createHash("sha256").update(`nimbus-takedown:${token}`).digest("hex")}`]]))[0] as number >= Math.floor((until + 20 * DAY - Date.now()) / 1000), true);

  part("When the creator was told is kept, read exactly (for the six months to ask us to look again, #3533)");
  const strike = held.strikes.find((x) => x.report === report.id && x.what.startsWith("The link \"Photo set\""));
  const toldAt = strike ? await noticeSentAt(report.id, strike) : "no strike";
  is("the send time is kept, between the press and now", typeof toldAt === "string" && Date.parse(toldAt) >= heldAt && Date.parse(toldAt) <= Date.now(), true);
  is("a strike whose notice never went out has none", await noticeSentAt(report.id, { at: "2026-01-01T00:00:00.000Z", what: "The link \"Never\" (https://example.com/never)" }), null);
  const sentKeyOf = (x: { at: string; what: string }) => `nl:report:${report.id}:s:${createHash("sha256").update(`nimbus-told:${x.at.slice(0, 30)}\n${x.what.slice(0, 200)}`).digest("hex").slice(0, 24)}`;
  const odd = { at: "2026-02-02T00:00:00.000Z", what: "The link \"Odd\" (https://example.com/odd)" };
  await redis.pipeline([["SET", sentKeyOf(odd), "yesterday"]]);
  is("a kept value that is not a time is unknown: it throws, never now and never not sent", await noticeSentAt(report.id, odd).then(() => "read", () => "threw"), "threw");

  part("Inside the window, nothing is deleted and nothing goes back");
  is("a run the day before the window ends", (await settleHeld(until - DAY)).deleted, 0);
  is("still held, its picture kept", [(await current()).heldLinks?.length, kept.has(keptAs)], [1, true]);

  part("A counter-notice: the same link and the same picture, back at the same address, 10 to 14 business days later");
  const answered = await act(new NextRequest(`${ORIGIN}/api/takedown`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com" }, body: JSON.stringify({ token, action: { type: "held", id: first.id, op: "counter" } }) }));
  const answer = await answered.json() as { ok?: boolean; done?: string };
  is("recorded from the notice's page", [answered.status, answer.ok, typeof answer.done === "string" && answer.done.length > 0], [200, true, true]);
  const back = restoreFrom(Date.now());
  is("the time it goes back is kept with it", Date.parse((await current()).heldLinks?.[0]?.counter ?? "") > 0, true);
  is("a run before 12 full weekdays: not back yet", [(await settleHeld(back - 1)).restored, (await current()).links.some((l) => l.id === first.id)], [0, false]);
  is("and not deleted either", [(await settleHeld(back - 1)).deleted, (await current()).heldLinks?.length], [0, 1]);
  is("the run on the 13th weekday puts it back", (await settleHeld(back)).restored, 1);
  const restored = await current();
  is("the same link, at the same place", [restored.links.findIndex((l) => l.id === first.id), restored.links.find((l) => l.id === first.id)], [place, original]);
  is("nothing is held any more", restored.heldLinks?.length ?? 0, 0);
  is("its picture answers at its old address, with the same bytes", await fetchPicture(first.path), [200, first.bytes]);
  is("the copy under the other name is gone", kept.has(keptAs), false);
  is("the creator is told it is back", sent.some((m) => m.subject.includes("back on your store") && m.text.includes("Photo set")), true);
  is("a second run does nothing", (await settleHeld(back + DAY)).restored, 0);

  part("Without a counter-notice: deleted when the window ends, as before");
  const second = await pictured("Old poster", 2);
  await takeDown(report, await current(), { type: "link", id: second.id }, ORIGIN, token);
  const second0 = (await current()).heldLinks?.find((h) => h.link.id === second.id);
  const secondUntil = Date.parse(second0?.until ?? "");
  const secondKept = second0?.picture ?? "";
  is("held, its picture kept", [Boolean(second0), kept.has(secondKept), (await fetchPicture(second.path))[0]], [true, true, 404]);
  is("a counter-notice after the window is refused", await actOnHeld(report, await current(), second.id, "counter", ORIGIN, secondUntil + 1), null);
  is("the run after the window deletes it", (await settleHeld(secondUntil + 1)).deleted, 1);
  is("the link and its picture are gone, never back", [(await current()).heldLinks?.some((h) => h.link.id === second.id) ?? false, (await current()).links.some((l) => l.id === second.id), kept.has(secondKept), kept.has(second.path)], [false, false, false, false]);

  part("The sender went to court: it stays down, and is deleted when the window ends");
  const third = await pictured("Cover scan", 3);
  await takeDown(report, await current(), { type: "link", id: third.id }, ORIGIN, token);
  const thirdHeld = (await current()).heldLinks?.find((h) => h.link.id === third.id);
  const thirdUntil = Date.parse(thirdHeld?.until ?? "");
  is("a counter-notice is recorded", typeof (await actOnHeld(report, await current(), third.id, "counter", ORIGIN, Date.now())), "string");
  is("then the sender's word that they went to court", typeof (await actOnHeld(report, await current(), third.id, "court", ORIGIN)), "string");
  is("it is not put back on the 13th weekday", [(await settleHeld(restoreFrom(Date.now()) + DAY)).restored, (await current()).links.some((l) => l.id === third.id)], [0, false]);
  is("it is deleted once the window is over", [(await settleHeld(Math.max(thirdUntil, restoreFrom(Date.now())) + DAY)).deleted, kept.has(thirdHeld?.picture ?? "")], [1, false]);

  part("Rule 24: an unknown never puts it back, never deletes it early and never serves it");
  const fourth = await pictured("Mixtape cover", 4);
  await takeDown(report, await current(), { type: "link", id: fourth.id }, ORIGIN, token);
  const fourthHeld = (await current()).heldLinks?.find((h) => h.link.id === fourth.id);
  await actOnHeld(report, await current(), fourth.id, "counter", ORIGIN, Date.now());
  const due = restoreFrom(Date.now());
  faults.copy = 1;
  const failedCopy = await settleHeld(due);
  is("the file store does not confirm the copy back: not put back, counted as failed", [failedCopy.restored, failedCopy.failed > 0, (await current()).links.some((l) => l.id === fourth.id)], [0, true, false]);
  is("still held, its picture kept, its old address still not found", [(await current()).heldLinks?.some((h) => h.link.id === fourth.id), kept.has(fourthHeld?.picture ?? ""), (await fetchPicture(fourth.path))[0]], [true, true, 404]);
  const realPipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "ZRANGEBYSCORE")) return [{ odd: true }];
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const oddRun = await settleHeld(due + 400 * DAY).catch(() => "threw" as const);
  redis.pipeline = realPipeline;
  is("a list of held stores answered in another shape: nothing done", [oddRun === "threw" || oddRun.failed > 0, (await current()).heldLinks?.some((h) => h.link.id === fourth.id), kept.has(fourthHeld?.picture ?? "")], [true, true, true]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "GET")) throw new Error("the store did not answer");
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const unread = await settleHeld(due + 400 * DAY).catch(() => "threw" as const);
  redis.pipeline = realPipeline;
  is("a store that cannot be read: nothing done", [unread === "threw" || unread.failed > 0, (await current()).heldLinks?.some((h) => h.link.id === fourth.id), kept.has(fourthHeld?.picture ?? "")], [true, true, true]);
  is("a later healthy run puts it back", [(await settleHeld(due + DAY)).restored, (await fetchPicture(fourth.path))[0]], [1, 200]);

  part("A store that is gone leaves the daily job's index; one that cannot be read stays in it (review of #3539)");
  const HELD = "nl:report:held";
  const inIndex = async (ref: string) => (await redis.pipeline([["ZSCORE", HELD, ref]]))[0] !== null;
  const spare = await createStore(OWNER, "holdingspare", "Holding spare", "");
  if (!spare.ok) throw new Error("no spare store");
  await redis.pipeline([["ZADD", HELD, Date.now(), storeRef(spare.store)]]);
  is("the control: the spare store is in the index", await inIndex(storeRef(spare.store)), true);
  is("deleting the store takes it off the index", [(await deleteStore(storeRef(spare.store))).ok, await inIndex(storeRef(spare.store))], [true, false]);
  const closing = await createStore(OWNER, "holdingclose", "Holding close", "");
  if (!closing.ok) throw new Error("no closing store");
  await redis.pipeline([["ZADD", HELD, Date.now(), storeRef(closing.store)]]);
  await closeStoreRecord(closing.store);
  is("closing the store takes it off the index", await inIndex(storeRef(closing.store)), false);
  const goneRef = "gone-holder@example.test";
  await redis.pipeline([["ZADD", HELD, Date.now(), goneRef]]);
  const goneRun = await settleHeld(Date.now() + 1);
  is("an entry whose store is gone (no record): dropped, and the run is not a failure", [goneRun.failed, await inIndex(goneRef)], [0, false]);
  is("a second run: still nothing failed", (await settleHeld(Date.now() + 1)).failed, 0);
  const oddRef = "odd-holder@example.test";
  await redis.pipeline([["ZADD", HELD, Date.now(), oddRef]]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EXISTS")) return [{ odd: true }];
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const oddGone = await settleHeld(Date.now() + 1);
  redis.pipeline = realPipeline;
  is("a store whose presence answers in another shape: kept in the index, counted as failed (rule 24)", [oddGone.failed > 0, await inIndex(oddRef)], [true, true]);
  await redis.pipeline([["ZREM", HELD, oddRef]]);
  const twoRef = "two-holder@example.test";
  await redis.pipeline([["ZADD", HELD, Date.now(), twoRef]]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "ZREM" && commands[0][2] === twoRef) return [2];
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  const twoRun = await settleHeld(Date.now() + 1);
  redis.pipeline = realPipeline;
  is("a removal of one member answered with 2 (not applied): not taken for a removal, counted as failed, still indexed", [twoRun.failed > 0, await inIndex(twoRef)], [true, true]);
  is("a later healthy run drops it", [(await settleHeld(Date.now() + 1)).failed, await inIndex(twoRef)], [0, false]);

  part("A put-back that finds the hold gone leaves no picture behind (review of #3539)");
  const sixth = await pictured("Zine scan", 6);
  await takeDown(report, await current(), { type: "link", id: sixth.id }, ORIGIN, token);
  const sixthHeld = (await current()).heldLinks?.find((h) => h.link.id === sixth.id);
  await actOnHeld(report, await current(), sixth.id, "counter", ORIGIN, Date.now());
  hooks.onCopy = async () => {
    if (!sixthHeld || !(await dropHeldLink(OWNER, sixthHeld.report, sixthHeld.link.id, sixthHeld.heldAt))) throw new Error("not dropped");
  };
  const lost = await settleHeld(restoreFrom(Date.now()));
  is("the hold went while the picture was copied back: nothing put back", [lost.restored, (await current()).links.some((l) => l.id === sixth.id)], [0, false]);
  is("the copy at the old address and the kept copy are both deleted", [kept.has(sixth.path), kept.has(sixthHeld?.picture ?? ""), (await fetchPicture(sixth.path))[0]], [false, false, 404]);

  part("A notice page that never expires keeps never expiring (review of #3539)");
  const tokenKey = `nl:report:t:${createHash("sha256").update(`nimbus-takedown:${token}`).digest("hex")}`;
  const ttlBefore = (await redis.pipeline([["TTL", tokenKey]]))[0] as number;
  await redis.pipeline([["PERSIST", tokenKey]]);
  const seventh = await pictured("Flyer", 7);
  await takeDown(report, await current(), { type: "link", id: seventh.id }, ORIGIN, token);
  is("holding a link sets no expiry on it", (await redis.pipeline([["TTL", tokenKey]]))[0], -1);
  await redis.pipeline([["EXPIRE", tokenKey, ttlBefore]]);
  const seventhUntil = Date.parse((await current()).heldLinks?.find((h) => h.link.id === seventh.id)?.until ?? "");
  is("(the window ends and it is deleted, which frees its place)", (await settleHeld(seventhUntil + 1)).deleted, 1);

  part("A held link keeps its place in the store's list");
  const s = await current();
  const room = MAX_STORE_LINKS - s.links.length - 1;
  for (let i = 0; i < room; i += 1) if (!(await addStoreLink(OWNER, `Filler ${i}`, `https://example.com/f/${i}`)).ok) throw new Error("filler");
  const fifth = await pictured("Last one", 5);
  await takeDown(report, await current(), { type: "link", id: fifth.id }, ORIGIN, token);
  is("with one held, the list is full", (await addStoreLink(OWNER, "One more", "https://example.com/more")).ok, false);
  await actOnHeld(report, await current(), fifth.id, "counter", ORIGIN, Date.now());
  is("so it can always go back", [(await settleHeld(restoreFrom(Date.now()))).restored, (await current()).links.length], [1, MAX_STORE_LINKS]);

  part("Another kind of notice keeps its rule: the link and its picture are deleted at once");
  const other = readReport({ ...input, kind: "other", work: "This link sells counterfeit tickets." });
  if (!other.ok) throw new Error("notice not read");
  const illegal: Report = { ...other.report, id: "0f1e2d3c4b5a6978", at: new Date().toISOString(), handle: "holdingshop" };
  const s2 = await current();
  const victim = s2.links.find((l) => l.id === fifth.id)!;
  await takeDown(illegal, s2, { type: "link", id: victim.id }, ORIGIN);
  is("gone, nothing held, its file deleted", [(await current()).links.some((l) => l.id === victim.id), (await current()).heldLinks?.some((h) => h.link.id === victim.id) ?? false, kept.has(fifth.path)], [false, false, false]);
}

main().then(done, (error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
