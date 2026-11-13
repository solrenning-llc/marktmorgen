/**
 * The way back from PayPal's onboarding (app/api/store/paypal/onboarded) is a GET that any page can send the creator
 * to (the session cookie is SameSite=Lax, so a link from another site carries it), and it asks PayPal by the store's
 * own tracking id, which PayPal keeps for as long as the creator has not removed Marktmorgen in their PayPal settings.
 * The defect this file was written around: opening that address again, from the browser's history or from a link on
 * another site, connected the store's PayPal again after the creator had pressed "Stop selling with PayPal", and a
 * store that never asked to connect was connected all the same; buyers were then offered PayPal on a store whose
 * creator had turned it off. Now the way back is taken only after a connect started from this store's studio (a mark
 * kept a day, written by app/api/store/paypal/connect, ended by a successful way back and by disconnecting); any other
 * visit changes nothing. Synthetic store, session and PayPal only.
 */
import { NextRequest } from "next/server";
import { GET as onboarded } from "@/app/api/store/paypal/onboarded/route";
import { POST as connect } from "@/app/api/store/paypal/connect/route";
import { POST as disconnect } from "@/app/api/store/paypal/disconnect/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setPayPalSeller, storeForEmail } from "@/lib/store";
import "./redis-stub";
import { done, is, part } from "./check";

const PARTNER = "PARTNERMERCH01";
const CLIENT = "partner-client-replay";
const SELLER = "SELLERMERCH01";
process.env.PAYPAL_PARTNER_CLIENT_ID = CLIENT;
process.env.PAYPAL_PARTNER_SECRET = "partner-secret-replay";
process.env.PAYPAL_PARTNER_MERCHANT_ID = PARTNER;
process.env.PAYPAL_BN_CODE = "BN_REPLAY";
let integrationAsks = 0;
/** Runs while PayPal's integration lookup is pending, once: what the creator does meanwhile in another tab. */
let duringLookup: (() => Promise<void>) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "api-m.paypal.com") throw new Error(`Unexpected synthetic provider request: ${url}`);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAreplay", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/customer/partner-referrals" && init?.method === "POST") {
    return json({ links: [{ href: "https://www.paypal.com/bizsignup/partner/entry?referralToken=replay", rel: "action_url", method: "GET" }] }, 201);
  }
  const integrations = `/v1/customer/partners/${PARTNER}/merchant-integrations`;
  if (url.pathname === integrations) {
    integrationAsks += 1;
    const meanwhile = duringLookup;
    duringLookup = null;
    if (meanwhile) await meanwhile();
    return json({ merchant_id: SELLER, tracking_id: url.searchParams.get("tracking_id") });
  }
  if (url.pathname === `${integrations}/${SELLER}`) {
    return json({ merchant_id: SELLER, oauth_integrations: [{ integration_type: "OAUTH_THIRD_PARTY", oauth_third_party: [{ partner_client_id: CLIENT }] }], primary_email_confirmed: true, payments_receivable: true });
  }
  throw new Error(`Unexpected synthetic provider request: ${url}`);
}) as typeof fetch;

async function main() {
  const email = "paypal-replay@example.com";
  is("synthetic store", (await claimHandle(email, "paypalreplay", "A store", "")).ok, true);
  await ensureStatsId(email);
  await ensureStoreId(email);
  const sid = (await storeForEmail(email))!.sid;
  const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
  const posted = { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com" };
  const back = async () => {
    try {
      return await onboarded(new NextRequest(`https://marktmorgen.com/api/store/paypal/onboarded?store=${sid}`, { headers: { cookie, host: "marktmorgen.com" } }));
    } catch {
      // `after` has no request scope in a test: the notice it schedules is not this file's subject.
      return null;
    }
  };
  const said = (response: Response | null) => (response ? new URL(response.headers.get("location") ?? "", "https://marktmorgen.com").searchParams.get("paypal") : "threw");
  const seller = async () => (await storeForEmail(email))?.paypalSeller?.merchant ?? null;

  part("A store that never asked to connect is not connected by a visit to the way back");
  integrationAsks = 0;
  const cold = await back();
  is("nothing connected", await seller(), null);
  is("PayPal is not asked", integrationAsks, 0);
  is("told nothing was finished", said(cold), "id");

  part("After the creator stops selling with PayPal, the old way back does not connect it again");
  await setPayPalSeller(email, SELLER);
  try {
    await disconnect(new NextRequest("https://marktmorgen.com/api/store/paypal/disconnect", { method: "POST", headers: posted }));
  } catch {
    // The notice `after` schedules has no request scope here; the disconnect itself was written before it.
  }
  is("disconnected", await seller(), null);
  integrationAsks = 0;
  const replay = await back();
  is("still disconnected after the way back is opened again", await seller(), null);
  is("PayPal is not asked", integrationAsks, 0);
  is("told nothing was finished", said(replay), "id");

  part("A connect started from the studio is taken on the way back, once");
  await setPayPalSeller(email, SELLER);
  const started = await connect(new NextRequest("https://marktmorgen.com/api/store/paypal/connect", { method: "POST", headers: posted }));
  is("sent to PayPal", started.headers.get("location"), "https://www.paypal.com/bizsignup/partner/entry?referralToken=replay");
  const ready = await back();
  is("checked with PayPal and said ready", [said(ready), await seller()], ["ready", SELLER]);
  integrationAsks = 0;
  const again = await back();
  is("a second visit does not ask PayPal again", integrationAsks, 0);
  is("and leaves the connection as it is", await seller(), SELLER);
  is("without a notice that says it failed", said(again), null);

  part("A connect started and then stopped is not finished by the way back");
  await connect(new NextRequest("https://marktmorgen.com/api/store/paypal/connect", { method: "POST", headers: posted }));
  try {
    await disconnect(new NextRequest("https://marktmorgen.com/api/store/paypal/disconnect", { method: "POST", headers: posted }));
  } catch {
    // As above.
  }
  integrationAsks = 0;
  const stopped = await back();
  is("stays disconnected", [await seller(), integrationAsks, said(stopped)], [null, 0, "id"]);

  part("A disconnect while PayPal is being asked wins over the way back already on its way (Codex X4)");
  const stop = async () => {
    try {
      await disconnect(new NextRequest("https://marktmorgen.com/api/store/paypal/disconnect", { method: "POST", headers: posted }));
    } catch {
      // As above.
    }
  };
  await connect(new NextRequest("https://marktmorgen.com/api/store/paypal/connect", { method: "POST", headers: posted }));
  integrationAsks = 0;
  duringLookup = stop;
  const raced = await back();
  is("PayPal was asked, and the disconnect ran while it was", [integrationAsks, duringLookup], [1, null]);
  is("the store stays disconnected", await seller(), null);
  is("the way back does not say ready", said(raced) === "ready", false);

  part("A newer connect while an older way back is asking PayPal: only the newer one finishes");
  await connect(new NextRequest("https://marktmorgen.com/api/store/paypal/connect", { method: "POST", headers: posted }));
  duringLookup = async () => {
    await connect(new NextRequest("https://marktmorgen.com/api/store/paypal/connect", { method: "POST", headers: posted }));
  };
  const older = await back();
  is("the older way back connects nothing", [await seller(), said(older) === "ready"], [null, false]);
  // The store was disconnected, so this way back schedules the "connected" notice with `after`, which has no request
  // scope in a test and throws once the seller is written (`back` then answers null): the seller is what is checked.
  await back();
  is("the newer one does", await seller(), SELLER);
  done();
}

void main();
