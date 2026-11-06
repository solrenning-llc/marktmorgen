/**
 * Changing where a link in an already-sent email goes (124
 * [F2-EDIT-SENT-LINKS], unit 1; added 6 November 2026), end to end against
 * the in-memory Redis double, a stand-in sender and synthetic stores only:
 *
 *   - a one-off email made from now on has its links go through one
 *     redirect per link, the same for every reader (nothing of the reader
 *     in it), signed at send time with the address as it was sent; at most
 *     SENT_LINKS_MAX links an email, the rest go straight where written;
 *     what the reader sees written is the address as typed; the
 *     unsubscribe line is never wrapped;
 *   - the redirect is never open: an address it was not signed with, a
 *     signature for another store, link or email, is refused, never
 *     followed;
 *   - a change goes only to https, never with a name or password in it,
 *     only to a page of the store or another page on the host the link
 *     first went to; a link that went to the store stays in the store;
 *   - every change is kept, in order, with the original, up to
 *     SENT_LINK_CHANGES_MAX an email; an email of another store, one made
 *     before this existed and one not sent yet cannot be changed;
 *   - an edit that cannot be read (an unknown reply, a broken record, a
 *     record that names an address the rules refuse, a store not found)
 *     goes to the original address recorded at send time, never elsewhere;
 *   - each redirect is one public request of the store's window, counted
 *     before the edit is read, with one read of the edit; nothing about a
 *     click is written (no open, no click counted);
 *   - the edit's key is erased with the store, and its family is in the
 *     store data registry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { advanceBroadcast, broadcastKeys, createBroadcast, readBroadcast } from "@/lib/broadcasts";
import { SITE_URL } from "@/lib/site-url";
import { SENT_LINKS_MAX, SENT_LINK_CHANGES_MAX, SENT_LINK_REQUEST_UNITS, destinationProblem, linksOf } from "@/lib/sent-link-rules";
import { changeLink, readSentLinks, sentLinkKey } from "@/lib/sent-links";
import { GET } from "@/app/go/[handle]/[id]/[link]/route";
import { FAMILIES } from "./store-data-registry";
import { request as costOf } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const delivery = installSesMailFixture();
const home = `${SITE_URL}/@harbor`;
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

/** The hrefs of the links in the email's own words (the box before the foot). */
function bodyHrefs(html: string): string[] {
  const box = html.split('<div style="padding:20px 8px 0')[0];
  return [...box.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}

async function follow(href: string): Promise<{ status: number; location: string | null }> {
  const url = new URL(href);
  const parts = url.pathname.split("/");
  // /go/<handle>/<id>/<link>
  const response = await GET(new Request(url), { params: Promise.resolve({ handle: decodeURIComponent(parts[2] ?? ""), id: parts[3] ?? "", link: parts[4] ?? "" }) });
  return { status: response.status, location: response.headers.get("location") };
}

async function main(): Promise<void> {
  redis.clear();
  delivery.configure();
  delivery.reset();
  process.env.RESEND_API_KEY = "re_test_sent_links_only_a_stand_in";

  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Links00001", subscriptionId: "sub_Links00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  for (const name of ["ana", "ben"]) await upsertContact(store.listId!, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);

  const other = await claimHandle(OTHER, "dock", "Dock Bakery", "");
  if (!other.ok) throw new Error("no second store");
  await ensureStatsId(OTHER);
  await ensureListId(OTHER);
  await setSubscription(OTHER, { customerId: "cus_Links00002", subscriptionId: "sub_Links00002", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OTHER, { fromName: "Dock Bakery", address: "2 Main St, Portland, OR 97201" });
  const dock = (await storeForEmail(OTHER))!;
  await upsertContact(dock.listId!, "cy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);

  part("The links an email can have changed, read the way the email draws them");
  const body = [
    `Our new plan: ${home}/p/plan.`,
    "Watch the recipe: https://youtube.com/watch?v=1",
    "[Join the call](https://zoom.us/j/1)",
    `The plan again: ${home}/p/plan`,
  ].join("\n\n");
  is("distinct, in order, the full stop left with the sentence", linksOf(body), [`${home}/p/plan`, "https://youtube.com/watch?v=1", "https://zoom.us/j/1"]);
  const many = Array.from({ length: SENT_LINKS_MAX + 2 }, (_, i) => `https://example.com/page-${i}`).join("\n\n");
  is("at most SENT_LINKS_MAX an email", linksOf(many).length, SENT_LINKS_MAX);

  part("Sent from now on: one signed redirect a link, the same for every reader");
  const created = await createBroadcast(store, { subject: "News", body, productId: "", notProductId: "", sendAt: undefined });
  if (!created.ok) throw new Error(`no broadcast: ${created.reason}`);
  const id = created.broadcast.id;
  is("the email is marked as one whose links can be changed", created.broadcast.links, true);
  delivery.clearCaptured();
  const sent = (await advanceBroadcast(id, storeForHandle, Date.now() + 60_000))!;
  is("sent to both", [sent.status, sent.sent], ["sent", 2]);
  const byReader = new Map(delivery.sent.map((m) => [m.to.join(","), m.html]));
  const ana = bodyHrefs(byReader.get("ana@example.com") ?? "");
  const ben = bodyHrefs(byReader.get("ben@example.com") ?? "");
  is("four links in the words", ana.length, 4);
  is("every one goes through the redirect", ana.every((href) => href.startsWith(`${SITE_URL}/go/harbor/${id}/`)), true);
  is("the same link twice is the same redirect", ana[0], ana[3]);
  is("the same for every reader: nothing of the reader in it", ana, ben);
  is("nothing of the reader's address or token is on it", ana.some((href) => /ana|ben|%40|t=/.test(href.split("?")[0]) || /ana%40|ben%40/.test(href)), false);
  const html = byReader.get("ana@example.com") ?? "";
  is("the words are the address as typed", html.includes(`>${home}/p/plan</a>`) && html.includes(">https://youtube.com/watch?v=1</a>"), true);
  is("the unsubscribe line is not wrapped", /href="[^"]*\/unsubscribe\?t=/.test(html) && !/\/go\/[^"]*unsubscribe/.test(html), true);

  part("The redirect goes where the link was sent to");
  const first = await follow(ana[0]);
  is("a 302 to the store's page, tagged with the email", [first.status, first.location && new URL(first.location).pathname, first.location && new URL(first.location).searchParams.get("utm_campaign")], [302, "/@harbor/p/plan", `b-${id}`]);
  is("an outside address, untouched", (await follow(ana[1])).location, "https://youtube.com/watch?v=1");

  part("Never an open redirect");
  const tamper = (href: string, edit: (url: URL) => void) => { const url = new URL(href); edit(url); return url.toString(); };
  for (const [what, href] of [
    ["another address with the same signature", tamper(ana[1], (u) => u.searchParams.set("u", "https://evil.example/phish"))],
    ["no signature", tamper(ana[1], (u) => u.searchParams.delete("s"))],
    ["a signature changed", tamper(ana[1], (u) => u.searchParams.set("s", "0".repeat(32)))],
    ["another link's number", tamper(ana[1], (u) => { u.pathname = u.pathname.replace(/\/1x$/, "/2x"); })],
    ["another email's id", tamper(ana[1], (u) => { u.pathname = u.pathname.replace(id, "f".repeat(24)); })],
    ["another store's name", tamper(ana[1], (u) => { u.pathname = u.pathname.replace("/go/harbor/", "/go/dock/"); })],
    ["a subject line it was not sent with", tamper(ana[1], (u) => { u.pathname = u.pathname.replace(/\/1x$/, "/1a"); })],
    ["a number past the cap", tamper(ana[1], (u) => { u.pathname = u.pathname.replace(/\/1x$/, `/${SENT_LINKS_MAX}x`); })],
    ["javascript", tamper(ana[1], (u) => u.searchParams.set("u", "javascript:alert(1)"))],
  ] as const) {
    const answer = await follow(href);
    is(`${what}: refused, nowhere`, [answer.status, answer.location], [404, null]);
  }

  part("A change goes only where it is safe");
  const b = (await readBroadcast(id))!;
  for (const [what, n, to] of [
    ["not https", 1, "http://youtube.com/watch?v=2"],
    ["javascript", 1, "javascript:alert(1)"],
    ["a name and password in it", 1, "https://user:pw@youtube.com/watch?v=2"],
    ["another host", 1, "https://evil.example/phish"],
    ["another store here", 0, `${SITE_URL}/@dock`],
    ["a store link sent out of the store", 0, "https://youtube.com/watch?v=2"],
    ["a page of ours that is not the store", 1, `${SITE_URL}/go/dock/${"f".repeat(24)}/0x`],
    ["not an address", 1, "youtube watch 2"],
    ["too long", 1, `https://youtube.com/${"a".repeat(2_000)}`],
  ] as const) {
    const answer = await changeLink(store, b, n, to);
    is(`${what}: refused with words`, [answer.ok, !answer.ok && answer.reason, !answer.ok && typeof answer.message === "string" && answer.message.length > 10], [false, "to", true]);
  }
  is("refused changes wrote nothing", await readSentLinks(id), null);
  is("the rules say the same", destinationProblem("https://evil.example/", "https://youtube.com/watch?v=1", store) !== null, true);

  part("A change, kept with the original and every change before it");
  const one = await changeLink(store, b, 1, "https://youtube.com/watch?v=2");
  is("same host: changed", one.ok, true);
  is("the redirect goes to the new address", (await follow(ana[1])).location, "https://youtube.com/watch?v=2");
  const toStore = await changeLink(store, b, 1, `${home}/p/other`);
  is("to a page of the store: changed", toStore.ok, true);
  const second = await follow(ana[1]);
  is("and tagged with the email, as the store's pages are", [second.location && new URL(second.location).pathname, second.location && new URL(second.location).searchParams.get("utm_campaign")], ["/@harbor/p/other", `b-${id}`]);
  is("a store link to another of its pages", (await changeLink(store, b, 0, `${home}/p/other`)).ok, true);
  const kept = await readSentLinks(id);
  is("every change in order, by link", kept?.changes.map((c) => [c.n, c.to]), [[1, "https://youtube.com/watch?v=2"], [1, `${home}/p/other`], [0, `${home}/p/other`]]);
  is("the original is still the email's own", linksOf((await readBroadcast(id))!.body)[1], "https://youtube.com/watch?v=1");
  is("back to the original", (await changeLink(store, b, 1, "https://youtube.com/watch?v=1")).ok, true);
  is("the redirect goes there again", (await follow(ana[1])).location, "https://youtube.com/watch?v=1");
  is("the same address twice is no change, nothing kept", [(await changeLink(store, b, 1, "https://youtube.com/watch?v=1")).ok, (await readSentLinks(id))?.changes.length], [true, 4]);
  is("the key is the email's own", sentLinkKey(id), `nl:mail:bc:${id}:go`);
  const ttl = (await redis.pipeline([["TTL", sentLinkKey(id)]]))[0] as number;
  is("kept for a bounded time, never for good", ttl > 0 && ttl <= 400 * 86_400, true);

  part("Only the store's own sent emails, a bounded number of changes");
  is("another store's email", (await changeLink(dock, b, 1, "https://youtube.com/watch?v=3")).ok ? "changed" : "refused", "refused");
  is("a link it does not have", [(await changeLink(store, b, 3, "https://zoom.us/j/2")).ok, (await changeLink(store, b, -1, "https://zoom.us/j/2")).ok], [false, false]);
  const { links: _flag, ...withoutFlag } = b;
  void _flag;
  const old = await changeLink(store, withoutFlag, 1, "https://youtube.com/watch?v=3");
  is("an email sent before this existed", [old.ok, !old.ok && old.reason], [false, "old"]);
  const later = await createBroadcast(store, { subject: "Later", body, productId: "", notProductId: "", sendAt: Date.now() + 86_400_000 });
  if (!later.ok) throw new Error("no later broadcast");
  const unsent = await changeLink(store, later.broadcast, 1, "https://youtube.com/watch?v=3");
  is("one not sent yet", [unsent.ok, !unsent.ok && unsent.reason], [false, "unsent"]);
  for (let i = (await readSentLinks(id))!.changes.length; i < SENT_LINK_CHANGES_MAX; i += 1) await changeLink(store, b, 2, `https://zoom.us/j/${100 + i}`);
  const full = await changeLink(store, b, 2, "https://zoom.us/j/999");
  is("past SENT_LINK_CHANGES_MAX: refused, said", [full.ok, !full.ok && full.reason, (await readSentLinks(id))?.changes.length], [false, "full", SENT_LINK_CHANGES_MAX]);

  part("What cannot be read goes to the original recorded at send time");
  const original = redis.pipeline;
  const unknownReplies: [string, (commands: (string | number)[][]) => Promise<unknown[]> | null][] = [
    ["an error", (c) => (c.some((x) => x[1] === sentLinkKey(id)) ? Promise.reject(new Error("lost")) : null)],
    ["a number", (c) => (c.some((x) => x[1] === sentLinkKey(id)) ? Promise.resolve([42]) : null)],
    ["two replies", (c) => (c.some((x) => x[1] === sentLinkKey(id)) ? Promise.resolve(["{}", "{}"]) : null)],
    ["broken JSON", (c) => (c.some((x) => x[1] === sentLinkKey(id)) ? Promise.resolve(["{not json"]) : null)],
    ["a record of another list", (c) => (c.some((x) => x[1] === sentLinkKey(id)) ? Promise.resolve([JSON.stringify({ l: dock.listId, exp: 9e9, changes: [{ n: 2, to: "https://zoom.us/j/7", at: 1 }] })]) : null)],
    ["an address the rules refuse", (c) => (c.some((x) => x[1] === sentLinkKey(id)) ? Promise.resolve([JSON.stringify({ l: store.listId, exp: 9e9, changes: [{ n: 2, to: "https://evil.example/phish", at: 1 }] })]) : null)],
  ];
  const zoom = ana[2];
  is("the button was changed before", (await follow(zoom)).location?.startsWith("https://zoom.us/j/1") && (await follow(zoom)).location !== "https://zoom.us/j/1", true);
  for (const [what, swap] of unknownReplies) {
    redis.pipeline = async (commands) => (await swap(commands)) ?? original.call(redis, commands);
    try {
      is(`${what}: the original`, (await follow(zoom)).location, "https://zoom.us/j/1");
    } finally {
      redis.pipeline = original;
    }
  }

  part("One public request, counted before the one read; nothing about a click written");
  redis.clear();
  // A fresh world for the count: the store again, an email sent, a change.
  const again = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!again.ok) throw new Error("no store again");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Links00001", subscriptionId: "sub_Links00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const fresh = (await storeForEmail(OWNER))!;
  await upsertContact(fresh.listId!, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const c2 = await createBroadcast(fresh, { subject: "News", body, productId: "", notProductId: "", sendAt: undefined });
  if (!c2.ok) throw new Error("no second broadcast");
  delivery.clearCaptured();
  await advanceBroadcast(c2.broadcast.id, storeForHandle, Date.now() + 60_000);
  const link = bodyHrefs(delivery.sent[0]?.html ?? "")[1];
  await changeLink(fresh, (await readBroadcast(c2.broadcast.id))!, 1, "https://youtube.com/watch?v=9");
  const commands: (string | number)[][] = [];
  redis.pipeline = async (batch) => { commands.push(...batch); return original.call(redis, batch); };
  try {
    is("followed to the change", (await follow(link)).location, "https://youtube.com/watch?v=9");
  } finally {
    redis.pipeline = original;
  }
  const counted = commands.findIndex((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:"));
  const editRead = commands.findIndex((c) => c[1] === sentLinkKey(c2.broadcast.id));
  is("counted as one public request", commands.filter((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")).map((c) => c[2]), [SENT_LINK_REQUEST_UNITS]);
  is("before the edit is read, which is read once", [counted >= 0 && counted < editRead, commands.filter((c) => c[1] === sentLinkKey(c2.broadcast.id)).map((c) => c[0])], [true, ["GET"]]);
  const writes = commands.filter((c) => /^(SET|SADD|HSET|HINCRBY|INCR|INCRBY|LPUSH|RPUSH|ZADD|PFADD|SETEX|APPEND)$/.test(String(c[0])));
  is("nothing written but the store's request count", writes.every((c) => String(c[1]).startsWith("nl:traffic:") || String(c[1]).startsWith("nl:free")), true);
  is("bounded: a handful of commands", commands.length <= 16, true);
  is("a request costs more than what it reads", SENT_LINK_REQUEST_UNITS * laterPageCost() >= costOf("light", 16, 64_000), true);

  part("A store not found, or its requests used up: the original, never the change");
  await redis.pipeline([["SET", "nl:store:handle:harbor", "released:owner@example.com"]]);
  is("the original, tagged as it was sent", new URL((await follow(link)).location ?? "https://x.invalid/").toString(), "https://youtube.com/watch?v=1");

  part("Erased with the store, registered with its bound");
  is("one of the broadcast's keys", broadcastKeys(id).includes(sentLinkKey(id)), true);
  is("its family is in the store data registry", Object.hasOwn(FAMILIES, "nl:mail:bc:@lib/sent-links.ts"), true);

  part("The studio says it, plainly");
  const page = read("app/studio/email/links/page.tsx");
  const editor = read("components/sent-links-editor.tsx");
  is("the section's name", page.includes("Change where a link goes"), true);
  is("an email sent before cannot be changed, and it says so", /sent before/i.test(page + editor), true);
  is("the route needs the role that sends", /guardStoreWrite\(request, "send"/.test(read("app/api/store/mail/links/route.ts")), true);
  is("the email studio leads to it", read("app/studio/email/page.tsx").includes("studioPath(store, \"\", \"email/links\")"), true);
  is("no open, no click counted, in the route", !/noteClick|SADD|pixel/.test(read("app/go/[handle]/[id]/[link]/route.ts")), true);

  delivery.restore();
  done();
}

void main();
