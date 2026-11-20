/**
 * What Marktmorgen Path's evidence after a first sale (lib/path-growth-facts.ts,
 * readPathGrowth) reads of the store's one-off emails, measured on the real
 * database calls (regra 30, sibling of #3034): it took PATH_GROWTH_READ_UNITS
 * studio requests, then read the newest PATH_GROWTH_CAMPAIGNS emails whole
 * (listBroadcastsStrict, about 240 KB each as they cross) to learn only
 * whether one was sent. Held here, with synthetic stores only:
 *
 *   1. Every command and byte after its first take is inside what was taken
 *      when it is sent, with the emails at their longest; no body crosses.
 *   2. Whether an email was sent is still told exactly: sent, none of the
 *      few read, or unknown when not all were read.
 *   3. Without the studio requests the emails need, none is read, and that
 *      fact stays unknown (never "no email sent").
 */
import { readPathGrowth, PATH_GROWTH_CAMPAIGNS } from "@/lib/path-growth-facts";
import { chargeStudio } from "@/lib/path";
import type { PathMoney } from "@/lib/path-facts";
import { LONGEST, SMALL, idsFor, leaveStudio, makeStore, redis, watched, writeEmails } from "./broadcasts-read-cost-world";
import { done, is, part } from "./check";

const OWNER = "pathgrowthread@example.com";
const money = { at: 1_790_000_000_000, test: false, real: 1, cents: 1_000, currency: "usd", growth: { repeatBuyer: true, keptOrders: 2 } } as unknown as PathMoney;

async function main(): Promise<void> {
  redis.clear();
  const made = await makeStore(OWNER, "pathgrowthread");
  // No product listed: only the emails are measured here (the products' reading is its own, PATH_GROWTH_PRODUCTS).
  const store = { ...made, catalog: { ...made.catalog, items: [] } };
  const ids = idsFor(PATH_GROWTH_CAMPAIGNS, "ef");
  const run = () => watched(() => readPathGrowth(store, money, chargeStudio(store)));

  part("1. The newest emails at their longest: everything after the first take is inside what was taken");
  {
    await writeEmails(store, ids, () => LONGEST);
    const { result, sum } = await run();
    is("read", result !== "threw" && result.read, true);
    is("a sent email is found", result !== "threw" && result.facts.listEmailSent, true);
    is("nothing read before the first take", sum.readBefore, false);
    is(`every command and byte after it is inside what was taken when sent (${JSON.stringify({ paid: sum.paid, commands: sum.commands, bytes: sum.bytes })})`, sum.ok, true);
    is(`no body crosses (${sum.own.bytes + sum.bytes} bytes)`, sum.own.bytes + sum.bytes < 40_000, true);
  }

  part("2. Whether an email was sent is told exactly");
  {
    await writeEmails(store, ids.slice(0, 2), () => SMALL, () => ({ status: "scheduled", sent: 0, finishedAt: 0 }));
    is("fewer than it reads, none sent: no email sent", (await readPathGrowth(store, money, chargeStudio(store))).facts.listEmailSent, false);
    await writeEmails(store, ids, () => SMALL, () => ({ status: "scheduled", sent: 0, finishedAt: 0 }));
    is("as many as it reads, none sent: unknown", (await readPathGrowth(store, money, chargeStudio(store))).facts.listEmailSent, null);
    await writeEmails(store, ids, () => SMALL, () => ({ handle: "someone-else" }));
    is("sent under another store's address: unknown, never read as this store's", (await readPathGrowth(store, money, chargeStudio(store))).facts.listEmailSent, null);
    await writeEmails(store, ids.slice(0, 2), () => SMALL, (i) => (i === 1 ? { sent: -1 } : { status: "scheduled", sent: 0, finishedAt: 0 }));
    is("a record that is not one: unknown", (await readPathGrowth(store, money, chargeStudio(store))).facts.listEmailSent, null);
  }

  part("3. Without the studio requests the emails need, none is read");
  {
    await writeEmails(store, ids, () => LONGEST);
    // Its own first take, and nothing more.
    await leaveStudio(8, 5_000);
    const { result, log } = await run();
    is("the fact stays unknown, never 'no email sent'", result !== "threw" && result.facts.listEmailSent, null);
    is("no email read", log.some((e) => e.kind === "db" && e.reads.length > 0), false);
    await leaveStudio(5_000, 5_000);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
