/**
 * One read of a business's site ends inside the integration unit that prices it (coordinator cb12 on #5231).
 *
 * A read is one unit of the store's integrations, priced as ten seconds held while the other service answers
 * (tests/plan-cost-registry.ts, line integrations). lib/outreach.ts readSite asked for the robots.txt, the front page,
 * a moved origin's robots.txt and the contact pages one after another at PAGE_MS (8 s) each, so a slow site could hold
 * a read about 32 s. Now every page is asked for inside one deadline, READ_SITE_MS: each reader is told what is left
 * and is not waited for past it. A robots.txt or front page that did not answer in time ends the read with "timeout",
 * which the studio says plainly; a late contact page is left out, as one that did not answer.
 *
 * Synthetic pages only; no network (readSite takes the reader and the deadline).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { READ_SITE_MS, readSite, saveSender, startPitch, type PageReader } from "@/lib/outreach";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const FRONT = `<html><head><title>Rye Bakery</title></head><body><a href="/contact">Contact</a> hello@ryebakery.example.org</body></html>`;
const CONTACT = `<html><body>Partnerships: partners@ryebakery.example.org</body></html>`;

/** A reader that answers each page after `delay` ms (never, for the ones in `never`), noting what it was asked and the time it was given. */
function slowReader(delay: (url: string) => number | null) {
  const asked: { url: string; left: number | undefined }[] = [];
  const reader: PageReader = (url, left) => {
    asked.push({ url, left });
    const wait = delay(url);
    if (wait === null) return new Promise(() => undefined);
    const html = url.endsWith("/robots.txt") ? "User-agent: *\nDisallow:\n" : url.endsWith("/contact") ? CONTACT : FRONT;
    return new Promise((resolve) => setTimeout(() => resolve({ url, html }), wait));
  };
  return { reader, asked };
}

async function timed<T>(work: () => Promise<T>): Promise<{ result: T; took: number }> {
  const started = performance.now();
  const result = await work();
  return { result, took: performance.now() - started };
}

async function main(): Promise<void> {
  part("The deadline fits the unit that prices a read");
  is("READ_SITE_MS leaves room inside the ten seconds of an integration unit", READ_SITE_MS > 0 && READ_SITE_MS < 10_000, true);
  const registry = readFileSync(join(process.cwd(), "tests/plan-cost-registry.ts"), "utf8");
  is("the integrations line still prices a call as ten seconds", /held at 2 GB for ten seconds while the other service answers/.test(registry), true);

  part("A site that answers in time reads as before");
  const quick = slowReader(() => 1);
  const fine = await readSite("ryebakery.example.org", quick.reader, 2_000);
  is("read", fine.ok, true);
  is("its addresses, the contact page's first", fine.ok ? fine.site.found.map((a) => a.email) : [], ["partners@ryebakery.example.org", "hello@ryebakery.example.org"]);
  is("every reader is told the time left, never more than the read's own", quick.asked.every((a) => typeof a.left === "number" && a.left > 0 && a.left <= 2_000), true);

  part("A robots.txt that never answers ends the read on time, and is never read as one that asks nothing");
  const stuck = slowReader((url) => (url.endsWith("/robots.txt") ? null : 1));
  const robots = await timed(() => readSite("ryebakery.example.org", stuck.reader, 80));
  is("said as a timeout", robots.result, { ok: false, reason: "timeout" });
  is("ended by the deadline (under 2 s; the robots.txt never answers)", robots.took < 2_000, true);
  is("the front page is never asked for", stuck.asked.map((a) => a.url), ["https://ryebakery.example.org/robots.txt"]);

  part("A page that answers after the deadline does not hold the read past it")
  // The contact page answers after 3 s: without the deadline the read waited for it; with 300 ms it ends by then.
  const each = slowReader((url) => (url.endsWith("/contact") ? 3_000 : 1));
  const chain = await timed(() => readSite("ryebakery.example.org", each.reader, 300));
  is("the robots.txt and the front page arrive; the late contact page is left out", chain.result.ok ? chain.result.site.found.map((a) => a.email) : chain.result, ["hello@ryebakery.example.org"]);
  is("ended by the deadline, not by the late page (under 2 s)", chain.took < 2_000, true);
  const contactLeft = each.asked.find((a) => a.url.endsWith("/contact"))?.left;
  is("the contact page was given only what was left of the 300 ms", typeof contactLeft === "number" && contactLeft <= 300, true);

  part("A front page that does not answer in time is said as a timeout");
  const front = slowReader((url) => (url.endsWith("/robots.txt") ? 1 : null));
  const late = await timed(() => readSite("ryebakery.example.org", front.reader, 80));
  is("said as a timeout", late.result, { ok: false, reason: "timeout" });
  is("ended by the deadline (under 2 s; the front page never answers)", late.took < 2_000, true);

  part("A site that answers but cannot be read is still unreadable, not a timeout");
  const none: PageReader = async () => null;
  is("unreadable", await readSite("ryebakery.example.org", none, 2_000), { ok: false, reason: "unreadable" });

  part("A draft's reads before the model call end inside the same deadline (startPitch)");
  redis.clear();
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail("owner@example.com"))!;
  await saveSender(store, { name: "Jenny Park", address: "PO Box 12, Columbus, OH 43004, USA" });
  const input = { goal: "sponsor" as const, country: "US", isCompany: false, page: "https://ryebakery.example.org/contact", email: "partners@ryebakery.example.org", company: "Rye Bakery", about: "Bread.", notes: "I post three family recipes a week." };
  const draftRobots = slowReader((url) => (url.endsWith("/robots.txt") ? null : 1));
  const draft = await timed(() => startPitch(store, input, { reader: draftRobots.reader, readMs: 80 }));
  is("a robots.txt that never answers: said as a timeout", draft.result.ok ? "written" : draft.result.reason, "timeout");
  is("ended by the deadline (under 2 s)", draft.took < 2_000, true);
  is("the page itself is never asked for", draftRobots.asked.map((a) => a.url), ["https://ryebakery.example.org/robots.txt"]);
  const draftPage = slowReader((url) => (url.endsWith("/robots.txt") ? 1 : null));
  const lateDraft = await timed(() => startPitch(store, input, { reader: draftPage.reader, readMs: 80 }));
  is("a page that never answers: said as a timeout", lateDraft.result.ok ? "written" : lateDraft.result.reason, "timeout");
  is("ended by the deadline (under 2 s)", lateDraft.took < 2_000, true);
  is("every read of a draft is given at most the deadline", [...draftRobots.asked, ...draftPage.asked].every((a) => typeof a.left === "number" && a.left <= 80), true);

  part("The creator is told in plain words, and the route says it");
  const studio = readFileSync(join(process.cwd(), "components/outreach-studio.tsx"), "utf8");
  is("the studio has the words for a site that did not answer in time", /timeout: "Their website did not answer in time, so nothing was read\./.test(studio), true);
  const route = readFileSync(join(process.cwd(), "app/api/store/outreach/route.ts"), "utf8");
  is("the route answers a find's timeout as 504 with its reason", route.includes('read.reason === "timeout" ? 504'), true);
  is("and a draft's", route.includes('done.reason === "timeout" ? 504'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
