/**
 * The public deletion form asked for every store (/privacy/delete, scope=all;
 * lib/erasure-request.ts) must answer the same for every address (506 [SG1],
 * MM-SA-16, review C4-7). A stranger can spend a store's share of access
 * emails for visitors' addresses through its sign-up box; if the form then
 * answered "full" to an address only that store knows and "sent" to an
 * address no store knows, it would tell the stranger who buys there.
 *
 * So, without a store chosen, an address the store knows and one nobody
 * knows get exactly the same response (status, body and redirect), whether
 * the store has room, has none, or the email provider fails; and the page
 * that answer opens always gives the published privacy contact, so a person
 * whose link could not be sent is not left without a way to ask.
 */
import { readFileSync } from "node:fs";
import { isValidElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { rememberBuyers, storesKnownFor } from "@/lib/buyer-library";
import { takeAllowance, allowanceUsed } from "@/lib/store-allowance";
import { allowanceFor, askedCeiling } from "@/lib/store-allowance-rules";
import { POST as eraseRoute } from "@/app/api/privacy/erase/route";
import DeletePage from "@/app/privacy/delete/page";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: { to: string; text: string }[] = [];
let resendFails = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    if (resendFails) return new Response(JSON.stringify({ message: "down" }), { status: 500 });
    const body = JSON.parse(String(init?.body)) as { to?: unknown; text?: string };
    sent.push({ to: String(body.to), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

async function paidStore(handle: string): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1${handle.replace(/[^a-z]/g, "").padEnd(14, "x").slice(0, 14)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/[^a-z0-9]/g, "")}`, subscriptionId: `sub_${handle.replace(/[^a-z0-9]/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

/** Spends a store's whole share for visitors' addresses, as a stranger filling its sign-up box would. */
async function fill(store: Store): Promise<void> {
  const share = askedCeiling(allowanceFor(store, "transactional")) - (await allowanceUsed(store, "transactional"));
  if (share > 0 && !(await takeAllowance(store, "transactional", share, Date.now(), true)).ok) throw new Error("could not fill");
}

/** The text and the links of the page's chosen branch, without running its client parts. */
function walk(node: ReactNode, out = { text: "", hrefs: [] as string[] }): typeof out {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (typeof node === "string" || typeof node === "number") {
    out.text += String(node);
    return out;
  }
  if (!isValidElement<{ children?: ReactNode; href?: unknown }>(node)) return out;
  if (typeof node.props.href === "string") out.hrefs.push(node.props.href);
  walk(node.props.children, out);
  return out;
}

let ip = 0;
/** One ask with no store chosen, each from its own network address so the hourly limits never decide it. */
async function askAll(email: string): Promise<{ status: number; body: string; location: string }> {
  ip += 1;
  const response = await eraseRoute(
    new NextRequest("https://marktmorgen.com/api/privacy/erase", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${ip}` },
      body: new URLSearchParams({ action: "ask", email, scope: "all" }),
    }),
  );
  return { status: response.status, body: await response.text(), location: response.headers.get("location") ?? "" };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_scope_all_only_a_stand_in";
  const shop = await paidStore("erase-all-shop");
  const KNOWN = "only-at-shop@example.com";
  const STRANGER = "nobody-anywhere@example.com";
  await rememberBuyers(shop.sid, [KNOWN]);
  is("the known address is known to the store alone", await storesKnownFor(KNOWN), [shop.sid]);
  is("the stranger's address is known to no store", await storesKnownFor(STRANGER), []);

  part("The store has room: the known address gets the link, both get the same answer");
  let from = sent.length;
  const roomKnown = await askAll(KNOWN);
  const roomStranger = await askAll(STRANGER);
  is("only the known address was emailed", sent.slice(from).map((m) => m.to), [KNOWN]);
  is("the same response for both (status, body, redirect)", roomKnown, roomStranger);
  is("and that answer is 'sent'", new URL(roomKnown.location).searchParams.get("status"), "sent");

  part("The store's share for visitors is spent: still the same answer for both");
  await fill(shop);
  from = sent.length;
  const fullKnown = await askAll(KNOWN);
  const fullStranger = await askAll(STRANGER);
  is("nothing is sent", sent.length, from);
  is("the same response for both (status, body, redirect)", fullKnown, fullStranger);
  is("both are told 'sent', with no day in the link", [new URL(fullKnown.location).searchParams.get("status"), new URL(fullKnown.location).searchParams.has("opens")], ["sent", false]);

  part("The email provider fails: still the same answer for both");
  redis.clear();
  const again = await paidStore("erase-all-shop");
  await rememberBuyers(again.sid, [KNOWN]);
  resendFails = true;
  const downKnown = await askAll(KNOWN);
  const downStranger = await askAll(STRANGER);
  resendFails = false;
  is("the same response for both (status, body, redirect)", downKnown, downStranger);

  part("The page that answer opens always gives the privacy contact");
  const page = walk(await DeletePage({ searchParams: Promise.resolve({ status: "sent" }) }));
  const policy = readFileSync("app/privacy/page.tsx", "utf8");
  is(
    "the contact is the one the Privacy Policy publishes, as a link and as text",
    [page.hrefs.includes("mailto:support@marktmorgen.com"), page.text.includes("support@marktmorgen.com"), policy.includes('href="mailto:support@marktmorgen.com"')],
    [true, true, true],
  );
  is("it does not promise the link will arrive", page.text.includes("If that address is known"), true);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
