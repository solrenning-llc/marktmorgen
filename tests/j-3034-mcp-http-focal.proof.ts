/** Separate bounded extraction of the unchanged get_emails assertion block from
 * final api-events-measured.test.ts. The full suite exceeded the 10k command cap
 * before this block; it is NOT called green. Setup is local synthetic key/store.
 */
import { POST as mcp } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { EMAILS_HEADS_WORK, EMAILS_PROBE_WORK, MAIL_REVENUE_BYTES, addWork, apiReadUnits, emailsSizesWork, emailsWork } from "@/lib/api-read-rules";
import { broadcastHeadsBytes, broadcastSizesBytes, measureBroadcastHeads } from "@/lib/broadcasts";
import { flowsBytes } from "@/lib/flows";
import { keptMailRevenueBytes } from "@/lib/mail-revenue";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
const OWNER="events-measured@example.com",HANDLE="events-measured",ACCOUNT="acct_EventsTest01";
let commands: (string | number)[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = async (batch: (string | number)[][]) => {
  commands.push(...batch);
  return pipeline(batch);
};
let rpcId = 0;
const tool = async (key: string, name: string) =>
  (await (
    await mcp(new Request("https://marktmorgen.com/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: {} } }) }))
  ).json()) as { result?: { isError: boolean; content: { text: string }[] }; error?: { code: number; message: string } };
const mine = async () => (await storeForEmail(OWNER))!;
const used = async () => allowanceUsed(await mine(), "api");
async function leave(n: number): Promise<void> {
  const store = await mine();
  const [, keys] = (await redis.pipeline([["SCAN", "0", "MATCH", "nl:allow:api:*", "COUNT", 10_000]]))[0] as [string, string[]];
  if (keys.length) await redis.pipeline([["DEL", ...keys]]);
  const left = allowanceFor(store, "api");
  if (left > n) is(`the month is taken down to ${n}`, (await takeAllowance(store, "api", left - n)).ok, true);
}

async function main() {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Events Measured", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_EventsMeasured01", subscriptionId: "sub_EventsMeasured01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await makeKey((await mine()).sid, "Synthetic reader");
  if (!made.ok) throw new Error("no synthetic key");
  const key = made.key;
  part("get_emails with a kept copy of what they sold of 172 KB: measured, set aside and settled at it");
  const store = await mine();
  const broadcastId = "b".repeat(24);
  await redis.pipeline([
    ["LPUSH", `nl:mail:bcs:${store.listId}`, broadcastId],
    ["SET", `nl:mail:bc:${broadcastId}`, JSON.stringify({ id: broadcastId, listId: store.listId, handle: HANDLE, subject: "Synthetic news", body: "Hello", productId: null, notProductId: null, who: "all", narrow: null, status: "sent", createdAt: 1_790_000_000, total: 10, sent: 10, sendAt: 1_790_000_000, finishedAt: 1_790_000_100, note: "", failures: 0, listed: true, tagged: true })],
  ]);
  const by: Record<string, { sales: number; cents: number }> = {};
  for (let i = 0; JSON.stringify({ by, partial: false }).length < 172_000; i += 1) by[`b-${String(i).padStart(24, "0")}x${"y".repeat(10)}`] = { sales: 1, cents: 99_999 };
  await redis.pipeline([["SET", `nl:stats:${store.statsId}:mailsales:v2`, JSON.stringify({ by, partial: false }), "EX", 600]]);
  const copy = (await keptMailRevenueBytes(store))!;
  // Regra 23: get_emails measures and reads its emails without their bodies, priced as they cross (lib/broadcasts.ts, #3034's siblings),
  // and reads them as listBroadcastsStrict does, so the synthetic record carries every field createBroadcast writes.
  // Measured here without a take; get_emails takes asking their sizes first, apart (Codex J 5811457165 on #3034).
  const sizesNow = await measureBroadcastHeads(store.listId, 30, async () => ({ ok: true }));
  if (!sizesNow.ok) throw new Error("the synthetic emails could not be measured");
  const sizing = apiReadUnits(emailsSizesWork(sizesNow.ids.length, broadcastSizesBytes(sizesNow.ids.length)));
  is("asking the email's size takes a request of its own", sizing, 1);
  const flowBytes = (await flowsBytes(store.listId))!;
  const emails = (revenueBytes: number) => addWork(EMAILS_PROBE_WORK, addWork(emailsWork({ broadcasts: sizesNow.ids.length, broadcastBytes: broadcastHeadsBytes(sizesNow.sizes), flowBytes, revenueBytes }), EMAILS_HEADS_WORK));
  const before = await used();
  const answered = await tool(key, "get_emails");
  const emailsTook = (await used()) - before;
  console.log(`  get_emails: a kept copy of ${copy.toLocaleString("en-US")} bytes takes ${emailsTook}; priced at ${MAIL_REVENUE_BYTES.toLocaleString("en-US")} it took ${1 + apiReadUnits(emails(MAIL_REVENUE_BYTES))}`);
  is("answered", answered.result?.isError, false);
  is("the copy is the size asked", copy >= 172_000, true);
  is("the requests taken are what the copy read costs, with the door's and asking the sizes", emailsTook, 1 + sizing + apiReadUnits(emails(copy)));
  // Regra 23 (#3034's siblings): was `emailsTook > 1 + apiReadUnits(emails(MAIL_REVENUE_BYTES))`. Reading the emails without their bodies adds
  // the script's two calls and its bytes, which carry the 64 KB price over the same whole request as the copy's (both 5 here), so what is held is
  // that the copy's own bytes, not 64 KB, are in what is priced, and never less than the 64 KB price.
  is("the copy's own bytes are priced, not its old 64 KB", [emails(copy).bytes - emails(MAIL_REVENUE_BYTES).bytes, emailsTook >= 1 + apiReadUnits(emails(MAIL_REVENUE_BYTES))], [copy - MAIL_REVENUE_BYTES, true]);
  await leave(sizing + apiReadUnits(emails(copy)));
  commands = [];
  const short = await tool(key, "get_emails");
  is("one short of it: refused, nothing read", [short.error?.code, /This read may take up to/.test(short.error?.message ?? ""), commands.some((c) => c[0] === "GET" && /^nl:(mail:|stats:.*:mailsales)/.test(String(c[1])))], [-32001, true, false]);

  is("refused read never dispatches a heads read-mode EVAL", commands.some(c => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:broadcast-heads:") && c[3 + Number(c[2])] !== "size"), false);
  done();
}
main().catch(error=>{console.error(error);process.exitCode=2;});
