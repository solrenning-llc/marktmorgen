/**
 * 623 [SZ7], unit 3: the public routes of "Email me when it's back".
 *
 * Asking (app/api/store/stock-alert): refused from another site; the store's
 * public request is taken before the product or its stock is read; a
 * per-connection and a per-address limit; only a sold-out limited product of
 * a store with its postal address takes an address; the confirmation is
 * taken from the store's figure before it goes, and when that figure is spent
 * nothing is sent, nothing is kept and the page says so. The email: HTML and
 * text, the creator's postal address, a stop link and one-click unsubscribe,
 * no picture to track an opening, in the store's language.
 *
 * Confirming (…/confirm) and leaving (…/leave): the button behind the
 * emailed link, the one-click stop honored at once. Synthetic Redis and email
 * service only.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setProductExtras, setLanguage, setSubscription, storeForEmail } from "@/lib/store";
import { POST as askRoute } from "@/app/api/store/stock-alert/route";
import { POST as confirmRoute } from "@/app/api/store/stock-alert/confirm/route";
import { POST as leaveRoute } from "@/app/api/store/stock-alert/leave/route";
import { STOCK_ALERT_DUE } from "@/lib/stock-alerts";
import { allowanceFor, askedCeiling } from "@/lib/store-allowance-rules";
import { takeAllowance } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Sent = { to: string | string[]; subject: string; text: string; html: string; headers?: Record<string, string> };
const mails: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails") {
    mails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const POSTAL = "12 Harbor Road, Portland, ME 04101";

function request(path: string, fields: Record<string, string> | null, ip = "7.7.7.7", site = "same-origin"): NextRequest {
  return new NextRequest(`https://marktmorgen.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": site, host: "marktmorgen.com", origin: site === "same-origin" ? "https://marktmorgen.com" : "https://elsewhere.example", "x-forwarded-for": ip },
    body: fields ? new URLSearchParams(fields).toString() : "",
  });
}

async function makeStore(owner: string, handle: string, opts: { postal?: boolean; paid?: boolean } = {}) {
  await claimHandle(owner, handle, "Harbor Prints", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  if (opts.paid !== false) await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: paidPeriod() });
  if (opts.postal !== false) await setMailSettings(owner, { fromName: "Harbor Prints", address: POSTAL });
  const made = await addProduct(owner, "Signed Print", "", "40", null);
  if (!made.ok) throw new Error("no product");
  await setProductExtras(owner, made.product.id, { stock: 1 });
  const store = (await storeForEmail(owner))!;
  redis.run(["HSET", `nl:stock:${store.statsId}:${made.product.id}`, "cs_sold", JSON.stringify({ until: 0, paid: true })]);
  return { store, pid: made.product.id };
}

const statusOf = (response: Response) => new URL(response.headers.get("location") ?? "https://x/").searchParams.get("status");
const tokenIn = (text: string, name: string) => text.match(new RegExp(`${name}=([0-9a-f]{48})`))?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const { store, pid } = await makeStore("owner@example.com", "harbor");
  const listKey = `nl:sa:${store.statsId}:${pid}`;
  const ask = (email: string, ip = "7.7.7.7", site = "same-origin", product = pid, handle = "harbor") =>
    askRoute(request("/api/store/stock-alert", { handle, product, email }, ip, site));

  part("Refused from another site, before anything is read, kept or sent");
  const cross = await ask("reader@example.com", "7.7.7.7", "cross-site");
  is("403", cross.status, 403);
  is("nothing kept, nothing sent", [redis.run(["EXISTS", listKey]), mails.length], [0, 0]);

  part("An address asks on a sold-out product");
  const asked = await ask("Reader@Example.com");
  is("303 to the list's page, sent", [asked.status, asked.headers.get("location")], [303, `https://marktmorgen.com/@harbor/back-in-stock?product=${pid}&status=sent`]);
  is("the address is not in the page's address", asked.headers.get("location")!.includes("example.com"), false);
  is("one email", mails.length, 1);
  const mail = mails[0];
  is("to the address typed", mail.to, ["Reader@Example.com"]);
  is("subject", mail.subject, "Confirm: email me when Signed Print is back");
  const confirm = tokenIn(mail.text, "token");
  const leave = tokenIn(mail.text, "leave");
  is("a confirm link and a stop link, to the list's page", [confirm.length, leave.length, mail.text.includes("https://marktmorgen.com/@harbor/back-in-stock?token=")], [48, 48, true]);
  is("HTML and text, each with the creator's postal address", [Boolean(mail.html), mail.text.includes(POSTAL), mail.html.includes(POSTAL)], [true, true, true]);
  is("one-click unsubscribe for mail apps", [mail.headers?.["List-Unsubscribe"], mail.headers?.["List-Unsubscribe-Post"]], [`<https://marktmorgen.com/api/store/stock-alert/leave?h=harbor&t=${leave}>`, "List-Unsubscribe=One-Click"]);
  is("no picture, so nothing to track an opening", /<img\b/i.test(mail.html), false);
  is("the place is kept, not confirmed yet, and nothing is due", [typeof redis.run(["HGET", listKey, "reader@example.com"]), redis.run(["ZCARD", STOCK_ALERT_DUE])], ["string", 0]);

  part("The confirm button");
  const crossConfirm = await confirmRoute(request("/api/store/stock-alert/confirm", { handle: "harbor", token: confirm }, "7.7.7.7", "cross-site"));
  is("refused from another site", crossConfirm.status, 403);
  const confirmed = await confirmRoute(request("/api/store/stock-alert/confirm", { handle: "harbor", token: confirm }));
  is("confirmed", [confirmed.status, confirmed.headers.get("location")], [303, `https://marktmorgen.com/@harbor/back-in-stock?product=${pid}&status=confirmed`]);
  is("now due for the restock job", redis.run(["ZCARD", STOCK_ALERT_DUE]), 1);
  is("a made-up link", statusOf(await confirmRoute(request("/api/store/stock-alert/confirm", { handle: "harbor", token: "0".repeat(48) }))), "expired");
  is("the stop link cannot confirm", statusOf(await confirmRoute(request("/api/store/stock-alert/confirm", { handle: "harbor", token: leave }))), "expired");

  part("The stop link, honored at once");
  const crossLeave = await leaveRoute(request("/api/store/stock-alert/leave", { handle: "harbor", token: leave }, "7.7.7.7", "cross-site"));
  is("the page's button is refused from another site", crossLeave.status, 403);
  const oneClick = await leaveRoute(request(`/api/store/stock-alert/leave?h=harbor&t=${leave}`, null, "9.9.9.9", "cross-site"));
  is("one click from a mail app: done", oneClick.status, 200);
  is("the place is gone", redis.run(["HEXISTS", listKey, "reader@example.com"]), 0);
  is("pressed again from the page: not on the list", statusOf(await leaveRoute(request("/api/store/stock-alert/leave", { handle: "harbor", token: leave }))), "gone");

  part("Only a sold-out limited product takes an address");
  await setProductExtras("owner@example.com", pid, { stock: 2 });
  const sentBefore = mails.length;
  is("units left: closed", statusOf(await ask("in-stock@example.com", "7.7.8.1")), "closed");
  is("nothing sent or kept", [mails.length - sentBefore, redis.run(["HEXISTS", listKey, "in-stock@example.com"])], [0, 0]);
  await setProductExtras("owner@example.com", pid, { stock: 1 });
  const run = redis.run.bind(redis);
  const stockKey = `nl:stock:${store.statsId}:${pid}`;
  redis.run = (c: (string | number)[]) => (String(c[0]).toUpperCase() === "HGETALL" && c[1] === stockKey ? "garbage" : run(c));
  is("units left that cannot be read: an error, never a place", statusOf(await ask("unknown@example.com", "7.7.8.2")), "error");
  redis.run = run;
  is("nothing sent or kept", [mails.length - sentBefore, redis.run(["HEXISTS", listKey, "unknown@example.com"])], [0, 0]);
  is("not an address", statusOf(await ask("not an address", "7.7.8.3")), "email");
  const away = await ask("x@example.com", "7.7.8.4", "same-origin", "nosuchproduct");
  is("a product that is not there: back to the store", away.headers.get("location"), "https://marktmorgen.com/@harbor");

  part("A store with no postal address set takes no address");
  const bare = await makeStore("bare@example.com", "bareprints", { postal: false });
  is("closed", statusOf(await ask("a@example.com", "7.7.9.1", "same-origin", bare.pid, "bareprints")), "closed");
  is("nothing sent or kept", [mails.length - sentBefore, redis.run(["EXISTS", `nl:sa:${bare.store.statsId}:${bare.pid}`])], [0, 0]);

  part("The store's figure for confirmations, spent: nothing sent, nothing kept, and said so");
  const spent = await makeStore("spent@example.com", "spentprints");
  const share = askedCeiling(allowanceFor(spent.store, "transactional"));
  is("the share taken", (await takeAllowance(spent.store, "transactional", share, Date.now(), true)).ok, true);
  is("unsent", statusOf(await ask("b@example.com", "7.7.9.2", "same-origin", spent.pid, "spentprints")), "unsent");
  is("no email", mails.length - sentBefore, 0);
  is("the place was taken back", redis.run(["HLEN", `nl:sa:${spent.store.statsId}:${spent.pid}`]), 0);

  part("Limits: per address and per connection");
  for (let i = 0; i < 5; i += 1) await ask("same@example.com", `8.8.0.${i}`);
  is("a sixth ask for one address within the hour", statusOf(await ask("same@example.com", "8.8.0.9")), "limited");
  const statuses: (string | null)[] = [];
  for (let i = 0; i < 10; i += 1) statuses.push(statusOf(await ask(`reader${i}@example.com`, "8.8.1.1")));
  let reads = 0;
  redis.run = (c: (string | number)[]) => {
    if (String(c[1] ?? "").startsWith("nl:stock:") || String(c[1] ?? "").startsWith("nl:sa:") || String(c[1] ?? "").startsWith("nl:catalog:")) reads += 1;
    return run(c);
  };
  statuses.push(statusOf(await ask("reader10@example.com", "8.8.1.1")));
  redis.run = run;
  is("ten from one connection within the hour, then refused", [statuses.slice(0, 10).every((s) => s === "sent"), statuses[10]], [true, "limited"]);
  is("refused before the product, its stock or its list was read", reads, 0);

  part("In the store's language");
  await setLanguage("owner@example.com", "es");
  mails.length = 0;
  await ask("lector@example.com", "8.8.2.1");
  is("Spanish subject and html lang", [mails[0]?.subject, mails[0]?.html.includes('lang="es-ES"')], ["Confirma: avísame cuando Signed Print vuelva", true]);

  part("One click from a mail app still works after the store lets its old address go");
  mails.length = 0;
  await ask("mover@example.com", "8.8.3.1");
  const unsubscribe = (mails[0]?.headers?.["List-Unsubscribe"] ?? "").replace(/^<|>$/g, "");
  const moverLink = new URL(unsubscribe || "https://marktmorgen.com/");
  const moverLeave = moverLink.searchParams.get("t") ?? "";
  is("the place is kept", typeof redis.run(["HGET", listKey, "mover@example.com"]), "string");
  redis.run(["SET", "nl:store:handle:harbor", "released:owner@example.com"]);
  const stranger = new URL(moverLink);
  stranger.searchParams.set("i", "store_not_a_store");
  stranger.searchParams.delete("h");
  const notFound = await leaveRoute(request(`${stranger.pathname}${stranger.search}`, null, "9.9.3.2", "cross-site"));
  is("a store that cannot be found is never a silent 200", notFound.status === 200, false);
  is("and the place is still there", typeof redis.run(["HGET", listKey, "mover@example.com"]), "string");
  const released = await leaveRoute(request(`${moverLink.pathname}${moverLink.search}`, null, "9.9.3.1", "cross-site"));
  is("the email's own one-click link, after the old address was let go: done", [released.status, moverLeave.length], [200, 48]);
  is("the place is gone", redis.run(["HEXISTS", listKey, "mover@example.com"]), 0);
  is("pressed again: nothing left to stop, done", (await leaveRoute(request(`${moverLink.pathname}${moverLink.search}`, null, "9.9.3.1", "cross-site"))).status, 200);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
