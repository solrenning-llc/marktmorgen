import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanyOwnerReportView } from "../components/company-owner-report";

const NOW = Date.UTC(2026, 10, 5, 8);
test("the private server view exposes all unknown sources without needing a complete money report", () => {
  const html = renderToStaticMarkup(createElement(CompanyOwnerReportView, { snapshot: null, month: "2026-10", now: NOW }));
  assert.match(html, /lang="pt-BR"/);
  assert.equal((html.match(/<section /g) ?? []).length, 6);
  assert.equal((html.match(/<h2 /g) ?? []).length, 6);
  for (const id of ["closedData", "storeForget", "keptStar", "settlementEvidence", "sesPause", "manualLook"]) {
    assert.match(html, new RegExp(`aria-labelledby="owner-${id}"`));
    assert.match(html, new RegExp(`id="owner-${id}"`));
  }
  assert.equal((html.match(/estado desconhecido/g) ?? []).length, 6);
  assert.doesNotMatch(html, /<button|<form|<script|href=/);
});

test("rendering revalidates source data, escapes text and never displays supplied private fields", () => {
  const snapshot = JSON.stringify({
    keptStar: { month: "2026-10", times: 0, observedAtMs: NOW },
    sesPause: { status: "paused", observedAtMs: NOW, holdUntilMs: null, why: "synthetic@example.com<script>" },
  });
  const html = renderToStaticMarkup(createElement(CompanyOwnerReportView, { snapshot, month: "2026-10", now: NOW }));
  assert.match(html, /0 observações de lista/);
  assert.match(html, /dateTime="2026-11-05T08:00:00.000Z"/);
  assert.match(html, /Estado observado da Amazon SES: estado desconhecido/);
  assert.doesNotMatch(html, /synthetic@example|<script>/i);
  assert.match(html, /página autenticada e envio automático ainda não estão ligados/);
});
