/**
 * Every place that reads the store's currency, classified (22 [E5], unit 2a;
 * added 2 November 2026; docs/e5-money-readers.md). Once a product can be
 * priced in several currencies, an order may be paid in another one, so each
 * reader must say what it does with that: keep the store's own setting, make
 * a new charge (unit 3), take a past sale's own currency, charge again in the
 * order's currency, or total per currency, never converted (unit 2). Checked:
 * the inventory lists exactly the files that read it today, no more and no
 * fewer, each under one known class, so a new reader cannot slip in
 * unclassified.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const CLASSES = ["SETTING", "NEW-CHARGE", "PAST-SALE", "FOLLOW-UP-CHARGE", "TOTALS", "OTHER"];
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : []; });
const readers = ["app", "components", "lib"].flatMap(walk).filter((f) => /store\.currency|current\.currency|s\.currency\b/.test(readFileSync(f, "utf8"))).sort();
const doc = readFileSync("docs/e5-money-readers.md", "utf8");
const rows = [...doc.matchAll(/^\| `([^`]+)` \| ([A-Z-]+) \|/gm)].map((m) => ({ file: m[1], kind: m[2] }));

part("The inventory");
is("enough readers found to mean something", readers.length >= 80, true);
is("every file that reads the store's currency is listed", readers.filter((f) => !rows.some((r) => r.file === f)), []);
is("nothing listed that no longer reads it", rows.filter((r) => !readers.includes(r.file)).map((r) => r.file), []);
is("each listed once, under a known class", [rows.length === new Set(rows.map((r) => r.file)).size, rows.filter((r) => !CLASSES.includes(r.kind)).map((r) => r.file)], [true, []]);

done();
