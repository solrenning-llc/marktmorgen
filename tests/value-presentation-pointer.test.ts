/**
 * docs/value-presentation-2026-10-18.md points to the generated price and margin table; it never copies it
 * (BROADCAST-282, option F, the owner's "faça o mais correto e seguro", 18 November 2026). The copy had to match
 * scripts/margin-alignment.mjs line by line, so every PR that moved a cost conflicted in this file as well as in the
 * generated documents. Now the current rows live only in the margin report, generated on demand by
 * scripts/margin-alignment.mjs (owner, 20/11/2026: docs/margin-alignment-2026-10-18.md holds only a fixed text), and
 * value-presentation keeps the owner's quotes, the method,
 * the competitors read and its dated tables, each marked as history.
 */
import { readFileSync } from "node:fs";
import { ASSISTANT_ON_SALE, PLANS_ON_SALE } from "@/lib/opening";
import { TIERS } from "@/lib/plan";
import { allUnits, currentPriceMarginRows, renderMarginAlignment } from "./margin-alignment-table";
import { done, is, part } from "./check";

const VALUE = "docs/value-presentation-2026-10-18.md";
const value = readFileSync(VALUE, "utf8");
const valueLines = value.split("\n");
const alignmentLines = new Set(renderMarginAlignment(PLANS_ON_SALE, ASSISTANT_ON_SALE).split("\n"));
const rows = currentPriceMarginRows(PLANS_ON_SALE, ASSISTANT_ON_SALE);
const units = allUnits(PLANS_ON_SALE, ASSISTANT_ON_SALE);

part("(a) The current-price section points to the generated table");
const heading = valueLines.findIndex((line) => line === "## MR — Current-price registered model (27 October2026)");
is("the section keeps its heading, so the link at the top of the file still lands", heading >= 0, true);
const section = valueLines.slice(heading + 1, (() => { const next = valueLines.findIndex((line, i) => i > heading && line.startsWith("## ")); return next < 0 ? valueLines.length : next; })()).join("\n");
is("it names the generated table's own section and links to its path", section.includes('section "Each current unit at full registered use"') && section.includes("(margin-alignment-2026-10-18.md)"), true);
is("and says the rows are generated on demand there, not copied here", /generated on demand by `node scripts\/margin-alignment\.mjs`/.test(section) && /not copied/.test(section), true);
is("the section it names is one the report renders", renderMarginAlignment(PLANS_ON_SALE, ASSISTANT_ON_SALE).includes("## Each current unit at full registered use"), true);

part("(b) No current-price row is copied into value-presentation");
const copied = rows.filter((row) => valueLines.includes(row));
is("no whole row of currentPriceMarginRows", copied, []);
const named = units.map((unit) => `| ${unit.name} |`).filter((start) => valueLines.some((line) => line.startsWith(start)));
is("no table line for a current unit, even one with older figures", named, []);

part("(c) The margin report, generated on demand, has every row");
is("every current-price row, as the generator writes it", rows.filter((row) => !alignmentLines.has(row)), []);
for (const tier of TIERS) {
  for (const cycle of ["month", "year"] as const) {
    const unit = units.find((one) => one.id.startsWith(`${tier}-${cycle}-`));
    is(`${tier} ${cycle === "month" ? "monthly" : "yearly"}: a unit and its row`, unit !== undefined && rows.some((row) => row.startsWith(`| ${unit.name} |`) && alignmentLines.has(row)), true);
  }
}

part("The dated tables that cite 60% are marked as history");
for (const title of ["## The price list", "## Which visible limits were raised, and why these"]) {
  const at = valueLines.indexOf(title);
  const table = valueLines.findIndex((line, i) => i > at && line.startsWith("| "));
  const between = valueLines.slice(at + 1, table).join("\n");
  is(`"${title.slice(3)}" says it is not the current price before its table`, at >= 0 && table > at && /Historical \(18 October 2026\): not the current price\./.test(between), true);
}

part("Unchanged: the owner's quotes and the checks on the words");
is("the owner's 11:21 quote stays", value.includes("preço: o que maximiza o meu lucro"), true);
is("no \"small\" and no unlimited visits, orders, emails or storage on a plan", /\bsmall\b|unlimited (visits|orders|emails|storage) on (Store|Studio|Scale)/i.test(value), false);
done();
