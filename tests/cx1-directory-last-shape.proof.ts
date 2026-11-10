import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AffiliateDirectory } from "@/components/affiliate-directory";
import { readDirectory, type DirectoryRow } from "@/lib/affiliate-directory";
import { DIRECTORY_BUILDS, DIRECTORY_LAST } from "@/lib/directory-index";
import { UnknownReplyError } from "@/lib/redis-reply";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
const sid = "cx1-directory-synthetic";
const row: DirectoryRow = { handle: "cx1program", name: "CX1", language: "en", currency: "usd", percent: 30, topRate: 30, topEarnCents: 300, days: 30, rule: "last", lifetime: false, payday: 1, hold: 30, buyers: false, products: [], earning: 1, numbers: null };
async function attempt(value: unknown) {
  redis.clear();
  await redisPipeline([["SET", DIRECTORY_BUILDS, "11", "EX", 600], ["SADD", "nl:dir:listed", sid], ["SET", DIRECTORY_LAST, JSON.stringify({ sids: [sid], rows: [value] }), "EX", 1200]]);
  let rows: DirectoryRow[] | null = null;
  try { rows = await readDirectory(); }
  catch (e) { return { unknown: e instanceof UnknownReplyError, accepted: false, renders: false }; }
  let renders = false;
  try { renderToStaticMarkup(createElement(AffiliateDirectory, { rows })); renders = true; } catch {}
  return { unknown: false, accepted: true, renders };
}
async function main() {
  part("CX1: a listed sid does not validate its cached display row");
  for (const value of [null, 1, {}, { ...row, products: null }, { ...row, language: "unknown-language" }]) {
    is(`malformed fallback ${JSON.stringify(value)}`, await attempt(value), { unknown: true, accepted: false, renders: false });
  }
  is("a valid fallback still renders", await attempt(row), { unknown: false, accepted: true, renders: true });
  done();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
