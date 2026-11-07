/**
 * What the marks on the numbers' chart (lib/auto-marks.ts, readMarks: the
 * studio's home, app/studio/page.tsx, and a stretch of days,
 * app/api/store/stats/range/route.ts) read of the store's one-off emails,
 * measured on the real database calls (regra 30, a sibling of #3034's
 * reading through listBroadcasts): the newest fifty emails read whole (each
 * up to about 240 KB as it crosses, about 12 MB in all) inside the page's or
 * the route's own studio requests, for a subject, a date and a count each.
 * Held here, with synthetic stores only:
 *
 *   1. Before any email is read, only the list and each one's size without
 *      its body are asked, small; the studio requests reading them comes to
 *      are taken first; every command and byte after that is inside what was
 *      taken when it is sent, and no body crosses.
 *   2. The marks are the same as from the emails read whole.
 *   3. Without the studio requests they need, no email is read and the chart
 *      has no email marks; its other marks stay.
 */
import { readFileSync } from "node:fs";
import { readMarks, marksFrom } from "@/lib/auto-marks";
import { listBroadcasts } from "@/lib/broadcasts";
import { LONGEST, idsFor, leaveStudio, makeStore, redis, watched, writeEmails } from "./broadcasts-read-cost-world";
import { done, is, part } from "./check";

/** The emails the marks read (readMarks: listBroadcasts(store.listId, 50)). */
const READ = 50;
const OWNER = "marksread@example.com";
const FROM = "2000-01-01";
const TO = "2100-01-01";

async function main(): Promise<void> {
  redis.clear();
  const made = await makeStore(OWNER, "marksread");
  const store = { ...made, pastSales: [{ name: "Spring", percent: 20, starts: 1_700_000_000, ends: 1_700_086_400 }] } as typeof made;
  const ids = idsFor(READ, "aa");
  await writeEmails(store, ids, () => LONGEST);
  const run = () => watched(() => readMarks(store, FROM, TO));

  is("the marks read their emails without their bodies, and no longer whole", (() => {
    const source = readFileSync("lib/auto-marks.ts", "utf8");
    return /readBroadcastHeads\(/.test(source) && !/listBroadcasts\(/.test(source);
  })(), true);

  part("1. Fifty emails at their longest: the reading is paid before any is read");
  {
    const { result, sum } = await run();
    is("marks read", Array.isArray(result) && result.filter((m) => m.kind === "email").length, READ);
    is(`only the list and the sizes are asked before a take, small (${JSON.stringify(sum.own)})`, sum.own.commands <= 1 + 1 + READ && sum.own.bytes <= 8_000, true);
    is("no email is read before the studio requests are taken", sum.readBefore, false);
    is(`every command and byte after it is inside what was taken when sent (${JSON.stringify({ paid: sum.paid, commands: sum.commands, bytes: sum.bytes })})`, sum.ok, true);
    is(`no body crosses (${sum.own.bytes + sum.bytes} bytes)`, sum.own.bytes + sum.bytes < 60_000, true);
  }

  part("2. The same marks as from the emails read whole");
  {
    const now = Date.now();
    const whole = marksFrom({ emails: await listBroadcasts(store.listId, READ), products: [], sales: [...(store.pastSales ?? []), store.sale], from: FROM, to: TO, now });
    is("same marks", await readMarks(store, FROM, TO, now), whole);
  }

  part("3. Without the studio requests they need, no email is read");
  {
    await leaveStudio(0, 5_000);
    const { result, log } = await run();
    is("no email read", log.some((e) => e.kind === "db" && e.reads.length > 0), false);
    is("no email mark, the sale's marks stay", Array.isArray(result) ? [result.filter((m) => m.kind === "email").length, result.filter((m) => m.kind === "sale").length] : result, [0, 2]);
    await leaveStudio(5_000, 5_000);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
