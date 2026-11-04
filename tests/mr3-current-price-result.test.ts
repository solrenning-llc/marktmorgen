import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAN_PRICES, TIERS, type Cycle } from '../lib/plan';
import { GATE_READING_ID, gateReading } from '../lib/tax-gate';
import { reviewedUnitUnder } from '../lib/reviewed-receiving';

const report = readFileSync('docs/mr3-current-price-result-2026-10-27.md', 'utf8');
const boundary = '\n## Histórico integral — relatórios anteriores a 04/11/2026\n';
const current = report.split(boundary)[0];

// The document is the owner-facing result, so test what its current section
// tells the reader, against the current model, rather than a copied tax rate.
test('MR3 leads with LC/TX and archives the superseded result before its old claims', () => {
  assert.ok(report.includes(boundary), 'earlier reports need an explicit history boundary');
  assert.match(current, /LC.*TX/);
  assert.match(current, /100%.*pior mês/);
  assert.match(current, /fora.*piso.*histórico/);
  assert.doesNotMatch(current, /leitura vinculante continua com VAT|78,18%|ISS de 5% sobre a receita|gateReading.*mantém a leitura most-tax/);
  assert.ok(report.indexOf('A leitura vinculante continua com VAT') > report.indexOf(boundary), 'old text is retained only in history');
});

test('MR3 identifies the live selector and never treats metadata as reviewed taxes', () => {
  assert.ok(current.includes('`GATE_READING_ID=' + GATE_READING_ID + '`'));
  assert.ok(current.includes('`gateReading()=' + gateReading().id + '`'));
  assert.match(current, /seletor.*não.*prova/i);
  assert.match(current, /revisão.*livros.*câmbio/i);
  for (const tier of TIERS) {
    for (const cycle of ['month', 'year'] as const) {
      assert.equal(reviewedUnitUnder(PLAN_PRICES[tier][cycle], 0, null), null,
        'missing tax evidence is unknown even with no supplied usage');
    }
  }
  assert.match(current, /lucro integral.*desconhecido/i);
  assert.match(current, /base mínima.*não estabelecida/i);
});

test('MR3 lists every preserved plan price while all results remain explicitly unknown', () => {
  const rows = current.split('\n').filter(line => /^\| (creator|pro|scale)_(month|year) \|/.test(line));
  assert.equal(rows.length, TIERS.length * 2);
  for (const tier of TIERS) {
    for (const cycle of ['month', 'year'] as Cycle[]) {
      const price = (PLAN_PRICES[tier][cycle] / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
      assert.ok(rows.includes(`| ${tier}_${cycle} | US$ ${price} | Desconhecido | Não estabelecida |`));
    }
  }
  assert.match(current, /700.*respostas/);
  assert.match(current, /não.*contrato anual.*assistente/i);
  assert.match(current, /após a abertura/);
  assert.match(current, /nenhuma.*trava.*alterada/i);
});
