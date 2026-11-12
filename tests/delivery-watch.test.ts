/**
 * The store that costs more than it pays, and whether we hear about it.
 *
 * Delivery is the one cost with no ceiling anywhere in the code. The 200 GB
 * a month the subscription covers is counted and never enforced, on purpose:
 * somebody paid the creator for that file, and cutting their buyer off to
 * protect our margin would be taking money for a sale and then not
 * completing it. So the protection cannot be a door. It has to be knowing.
 *
 * And we did not know. The creator could see they were over, in their own
 * studio, while the first we would have heard of a store moving twenty-five
 * terabytes was the invoice — a month late and already paid.
 *
 * These hold the part that closes it: a store is written down the moment it
 * crosses, exactly once, and the number we read back is the real one.
 *
 * Since October 7, 2026 a file that is sold is kept where sending it costs
 * nothing (lib/vault.ts), so a download is no longer the cost with no
 * ceiling: lesson video is, and tests/watch.test.ts holds what is set
 * against that. What is left here is the knowing, which a storefront still
 * needs: a store far past what a plan covers in downloads is told so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DELIVERY_ALLOWANCE_BYTES,
  bytesWords,
  deliveredThisMonth,
  recordDelivery,
  storesOverAllowance,
} from "@/lib/delivery";
import { store as redis } from "./redis-stub";

const GB = 1024 * 1024 * 1024;
const file = (handle: string) => `stores/${handle}/products/thing.zip`;

test("a store inside the allowance is counted and not named", async () => {
  await recordDelivery(file("quiet"), 10 * GB);
  const month = await deliveredThisMonth("quiet");
  assert.equal(month?.bytes, 10 * GB);
  assert.equal(month?.allowance, DELIVERY_ALLOWANCE_BYTES);
  assert.equal(month?.over, false);
  assert.deepEqual(
    (await storesOverAllowance()).map((s) => s.folder),
    [],
    "nothing to say on a quiet month",
  );
});

test("the delivery that crosses the line is the one that writes it down", async () => {
  // Right up to the line, and still nothing.
  await recordDelivery(file("busy"), DELIVERY_ALLOWANCE_BYTES - GB);
  assert.equal((await deliveredThisMonth("busy"))?.over, false);
  assert.equal(
    (await storesOverAllowance()).some((s) => s.folder === "busy"),
    false,
    "at the line is not over it",
  );

  // The next file takes it past.
  await recordDelivery(file("busy"), 2 * GB);
  assert.equal((await deliveredThisMonth("busy"))?.over, true);
  const over = await storesOverAllowance();
  const found = over.find((s) => s.folder === "busy");
  assert.ok(found, "the store is named once it is over");
  assert.equal(found.bytes, DELIVERY_ALLOWANCE_BYTES + GB, "with what it has actually sent");
});

test("a store far over is named once, not once per file", async () => {
  for (let i = 0; i < 40; i += 1) await recordDelivery(file("runaway"), 20 * GB);
  const named = (await storesOverAllowance()).filter((s) => s.folder === "runaway");
  assert.equal(named.length, 1, "a set, so forty more files do not make forty more rows");
  assert.equal(named[0].bytes, 800 * GB);
});

test("nothing is ever blocked, whatever the number says", async () => {
  // recordDelivery throws nothing and only answers whether it counted: it
  // cannot be the reason a buyer does not get what they paid for (a paid
  // file goes out whatever it answers, lib/serve-file.ts).
  const huge = await recordDelivery(file("runaway"), 5_000 * GB);
  assert.equal(huge, true);
  assert.equal((await deliveredThisMonth("runaway"))?.bytes, 5_800 * GB);
});

test("the worst offender is listed first, because that is the one to call", async () => {
  const over = await storesOverAllowance();
  const bytes = over.map((s) => s.bytes);
  assert.deepEqual(bytes, [...bytes].sort((a, b) => b - a));
  assert.equal(over[0].folder, "runaway");
});

test("a path that is not a store's file is not counted against anyone", async () => {
  await recordDelivery("not/a/store/path.zip", 900 * GB);
  await recordDelivery("", 900 * GB);
  assert.equal(
    (await storesOverAllowance()).some((s) => ["not", ""].includes(s.folder)),
    false,
  );
});

test("a size that is not a size is ignored rather than stored", async () => {
  const before = (await deliveredThisMonth("quiet"))?.bytes;
  await recordDelivery(file("quiet"), Number.NaN);
  await recordDelivery(file("quiet"), -5 * GB);
  await recordDelivery(file("quiet"), 0);
  assert.equal((await deliveredThisMonth("quiet"))?.bytes, before);
});

test("the figures read as figures in an email", () => {
  assert.equal(bytesWords(DELIVERY_ALLOWANCE_BYTES), "200 GB");
  assert.equal(bytesWords(1.5 * 1024 * GB), "1.5 TB");
  assert.equal(bytesWords(2.5 * GB), "2.5 GB");
  assert.equal(bytesWords(40 * GB), "40 GB");
});

test("the watch reads nothing when there is nothing written", async () => {
  redis.run(["DEL", "nl:store:delivery:over:" + new Date().toISOString().slice(0, 7)]);
  assert.deepEqual(await storesOverAllowance(), []);
});

test("the promise in the Terms is one the machine can keep alone", () => {
  const terms = readFileSync(join(process.cwd(), "app/terms/page.tsx"), "utf8");
  // The whole of section 5, to where it closes, however long it has grown.
  const from = terms.indexOf('id="fair-use"');
  const section = terms.slice(from, terms.indexOf("</LegalSection>", from));

  // The clause may not promise a letter that only a person could send.
  assert.doesNotMatch(
    section,
    /we will write to you first/,
    "a promise that waits for somebody to notice is not a promise. Section 5 should " +
      "describe the automatic notice, not a letter written by hand.",
  );
  assert.match(section, /automatic/, "it should say plainly that the notice is automatic");
  assert.match(
    section,
    /never\s+in the middle of delivering something a buyer has already paid for/,
    "and must keep the one thing that is never automated: cutting off a paid delivery",
  );

  // And the thing that sends it has to exist.
  const cron = readFileSync(join(process.cwd(), "app/api/cron/usage/route.ts"), "utf8");
  assert.match(cron, /ownersOf/, "the daily run must look up who to write to");
  assert.match(cron, /sendEmail/, "and actually send it");
  const vercel = readFileSync(join(process.cwd(), "vercel.json"), "utf8");
  assert.match(vercel, /\/api\/cron\/usage/, "and be scheduled, or it never runs");
});

test("a download is counted and published, and never charged for", async () => {
  const { DELIVERY_ALLOWANCE_BYTES } = await import("@/lib/delivery");
  const GB = 1024 * 1024 * 1024;

  // This used to hold a price for delivery past the allowance, fifteen cents
  // a gigabyte, which had to sit above what a download cost us. A file that
  // is sold is now kept where sending it costs nothing (lib/vault.ts), so
  // there is nothing left for a price to cover, and none is published. What
  // is charged by use is lesson video, by the hour watched, and it has its
  // own rules and its own tests (lib/watch-rules.ts, tests/watch.test.ts).
  const delivery = readFileSync(join(process.cwd(), "lib/delivery.ts"), "utf8");
  assert.doesNotMatch(delivery, /OVER_ALLOWANCE_CENTS_PER_GB/, "no price for a download is kept anywhere");

  const terms = readFileSync(join(process.cwd(), "app/terms/page.tsx"), "utf8");
  assert.match(terms, /Nothing is charged for downloads, inside that figure or past it/, "the Terms say so in as many words");
  assert.match(
    terms,
    /A paid download is never refused, at any number/,
    "and the promise that a buyer is never cut off has to stay next to it",
  );

  const studio = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
  assert.match(studio, /Nothing is charged for downloads above/, "and the creator reads the same thing where the figure is shown");

  // The figure a plan covers stays what was published.
  assert.ok(DELIVERY_ALLOWANCE_BYTES >= 200 * GB, "the allowance is not quietly made smaller");

  // The door to the host's own file store, where a download does cost, is
  // shut wherever the other store is set up, and on the paid site always.
  const door = readFileSync(join(process.cwd(), "app/api/store/file/route.ts"), "utf8");
  assert.match(
    door,
    /isVaultConfigured\(\) \|\| process\.env\.VERCEL_ENV === "production"/,
    "a sold file must not be able to land where sending it costs by the gigabyte",
  );
});
