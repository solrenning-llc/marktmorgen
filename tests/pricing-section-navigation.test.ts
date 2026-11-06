import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PricingPage from "@/app/pricing/page";
import { PRICING_GROUPS, PRICING_PLANS } from "@/lib/pricing-page-data";

type Props = { children?: ReactNode; className?: string; id?: string; "aria-label"?: string };
function nodes(node: ReactNode): ReactNode[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [node];
  return [node, ...nodes(node.props.children)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<Props>(node) ? text(node.props.children) : "";
}
const page = PricingPage();
const all = nodes(page);
const tables = all.filter(node => isValidElement(node) && node.type === "table");

test("pricing has six native section links with unique real destinations", () => {
  const nav = all.find(node => isValidElement<Props>(node) && node.type === "nav" && node.props["aria-label"] === "Pricing sections");
  assert.ok(nav, "the long page needs its own section index, separate from the shared header");
  const links = nodes(nav).filter(node => isValidElement<{ href?: string }>(node) && node.type === "a");
  assert.deepEqual(links.map(node => isValidElement<{ href: string }>(node) ? node.props.href : ""), ["#plans", "#limits-heading", "#addons-heading", "#calculator-heading", "#compare-heading", "#faq-heading"]);
  const fetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
  let html: string;
  try { html = renderToStaticMarkup(page); } finally { globalThis.fetch = fetch; }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  for (const node of links) if (isValidElement<{ href: string }>(node)) assert.equal(ids.filter(id => id === node.props.href.slice(1)).length, 1);
});

test("every allowance table is available at mobile width without a second stacked copy", () => {
  const hiddenTables: string[] = [];
  function visit(node: ReactNode, hidden: boolean) {
    if (Array.isArray(node)) { node.forEach(child => visit(child, hidden)); return; }
    if (!isValidElement<Props>(node)) return;
    const next = hidden || /\bhidden\s+md:block\b/.test(node.props.className ?? "");
    if (node.type === "table" && next) hiddenTables.push(text(node));
    visit(node.props.children, next);
  }
  visit(page, false);
  assert.equal(tables.length, PRICING_GROUPS.length);
  assert.equal(hiddenTables.length, 0, "mobile must use the same complete grouped tables");
  assert.equal(all.filter(node => isValidElement<Props>(node) && node.type === "dl" && /md:hidden/.test(node.props.className ?? "")).length, 0);
});

test("all canonical row labels, periods, notes and three plan values remain in the tables", () => {
  for (const [index, group] of PRICING_GROUPS.entries()) {
    const rows = nodes(tables[index]).filter(node => isValidElement(node) && node.type === "tr");
    assert.equal(rows.length, group.rows.length + 1);
    for (const plan of PRICING_PLANS) assert.ok(text(rows[0]).includes(plan.title));
    for (const [rowIndex, row] of group.rows.entries()) {
      const cells = nodes(rows[rowIndex + 1]).filter(node => isValidElement(node) && node.type === "td");
      assert.deepEqual(cells.map(text), PRICING_PLANS.map(plan => row.values[plan.tier]), row.key);
      assert.ok(text(rows[rowIndex + 1]).includes(row.label));
      if (row.note) assert.ok(text(rows[rowIndex + 1]).includes(row.note));
    }
    assert.ok(text(page).includes(group.period));
  }
  assert.ok(text(page).includes("Permissions, consent, funding checks and feature availability still apply."));
  assert.ok(text(page).includes("Annual billing does not turn a monthly allowance into a yearly pool."));
});

test("the index is sticky and touch-sized using pricing-only CSS, without hiding rows", () => {
  const css = existsSync("app/pricing/pricing.css") ? readFileSync("app/pricing/pricing.css", "utf8") : "";
  assert.match(css, /\.pricing-section-index\s*\{[^}]*position:\s*sticky/s);
  assert.match(css, /\.pricing-section-index a\s*\{[^}]*min-height:\s*44px/s);
  assert.doesNotMatch(css, /display:\s*none|visibility:\s*hidden|overflow:\s*hidden/);
});
