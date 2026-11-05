/**
 * 624 [SZ8](47): the public transparency page counts notices about content
 * as they happen: received when filed, acted on once per notice however many
 * steps it took, each kind of step, year by year from the day counting
 * began. Nothing about who sent a notice or which store it named.
 */
import { readFileSync } from "node:fs";
import { countNotice, countStep, transparencyCounts } from "@/lib/transparency";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  part("Nothing counted yet");
  is("no day, no years: the page says counting begins with the first notice", await transparencyCounts(), { since: null, years: [] });

  part("Counted as they happen");
  const jan = Date.UTC(2026, 0, 15);
  const nov = Date.UTC(2026, 10, 3);
  await countNotice("copyright", jan);
  await countNotice("other", nov);
  await countNotice("copyright", nov);
  await countStep({ id: "a".repeat(16), kind: "copyright" }, "product", nov);
  await countStep({ id: "a".repeat(16), kind: "copyright" }, "link", nov);
  await countStep({ id: "b".repeat(16), kind: "other" }, "store", nov);
  const counts = await transparencyCounts(nov);
  is("from the first day counted", counts.since, "2026-01-15");
  const y = counts.years[0];
  is("received, by kind", y.notices, { copyright: 2, other: 1 });
  is("acted on once per notice, however many steps", y.acted, { copyright: 1, other: 1 });
  is("each step counted", y.steps, { link: 1, product: 1, kit: 0, store: 1 });
  is("a made-up notice id is not counted", (await countStep({ id: "not-an-id", kind: "other" }, "kit", nov), (await transparencyCounts(nov)).years[0].steps.kit), 0);
  is("and a later year starts at nothing", (await transparencyCounts(Date.UTC(2027, 1, 1))).years.map((x) => [x.year, x.notices.copyright]), [["2027", 0], ["2026", 2]]);
  is("nothing about who or which store is kept", JSON.stringify(redis.keys()).includes("@") || redis.keys().some((k) => k.includes("store")), false);

  part("Where they are counted, and the page");
  const takedown = readFileSync("lib/takedown.ts", "utf8");
  is("a notice when filed, a step when taken", [takedown.includes("await countNotice(report.kind)"), takedown.includes("await countStep(report, action.type)")], [true, true]);
  const page = readFileSync("app/transparency/page.tsx", "utf8");
  is("orders from authorities are said not to be counted, never shown as zero", page.includes("Orders from courts or authorities are not counted on this page"), true);
  is("reached from the report form", readFileSync("app/report/page.tsx", "utf8").includes('href="/transparency"'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
