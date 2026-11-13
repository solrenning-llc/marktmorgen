/**
 * An emailed affiliate link signs a browser in once (lib/affiliates.ts openAffiliateLink: "an emailed link signs in
 * once"). The link was read, the work done, and only then deleted, so two presses at the same moment (a double click,
 * or a mail scanner and the browser) each read it and each got a 30-day affiliate session. Now the link is spent by the
 * one press whose DEL removed it; any other press of the same link is told it expired, and no second session is made.
 *
 * Synthetic only: an in-memory Redis, no email sent.
 */
import { createHash } from "node:crypto";
import { claimHandle, ensureStatsId, setAffiliateSetting, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { openAffiliateLink } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  const owner = "once@example.com";
  await claimHandle(owner, "onceshop", "Once Shop", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, rates: {} });
  const store = (await storeForEmail(owner))!;

  part("Two presses of the same link at once: one session, never two");
  // Someone already in the program (their first link opened), signing in again with a new link.
  const first = "c".repeat(64);
  await redis.pipeline([["SET", linkKey(first), JSON.stringify({ s: statsId, e: "pat@example.com", n: "" }), "EX", 600]]);
  is("their first link signs them in", (await openAffiliateLink(store, first)).ok, true);
  const before = redis.keys().filter((k) => k.startsWith("nl:aff:session:")).length;
  const token = "a".repeat(64);
  await redis.pipeline([["SET", linkKey(token), JSON.stringify({ s: statsId, e: "pat@example.com", n: "" }), "EX", 600]]);
  const results = await Promise.all([openAffiliateLink(store, token), openAffiliateLink(store, token)]);
  const opened = results.filter((r) => r.ok).length;
  is("exactly one press signs in", opened, 1);
  is("the other is told the link expired", results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.reason)), ["expired"]);
  const sessions = redis.keys().filter((k) => k.startsWith("nl:aff:session:"));
  is("one affiliate session more, not two", sessions.length - before, 1);

  part("Pressed again later: expired, nothing new");
  const again = await openAffiliateLink(store, token);
  is("the spent link is expired", again.ok ? "ok" : again.reason, "expired");

  part("A single press still signs in");
  const other = "b".repeat(64);
  await redis.pipeline([["SET", linkKey(other), JSON.stringify({ s: statsId, e: "lee@example.com", n: "" }), "EX", 600]]);
  is("one press: signed in", (await openAffiliateLink(store, other)).ok, true);
  done();
}

void main();
