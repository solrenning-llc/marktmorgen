/**
 * Which addresses have a store here is not told before a recent login and the
 * limits (Claude 5's authentication audit, M4).
 *
 * app/api/store/address answered "taken" for an address with a store before
 * it asked for a recent login and before the account's five addresses an
 * hour, so any creator, with a session of any age, could test without limit
 * whether an email is a Marktmorgen creator. The route already keeps the
 * same question about passkeys "slow and limited"; now the store question is
 * asked at the same place. Its sibling (rule 30): inviting a partner answered
 * `waiting: true` only when the address already had a store, and "full"
 * only when that store's studio had twenty offers waiting (pre-review D).
 *
 * Checked through the real routes with the in-memory Redis and a stand-in for
 * the email provider.
 */
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription } from "@/lib/store";
import { POST as addressRoute } from "@/app/api/store/address/route";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { offerPartnership, waitingFor } from "@/lib/partner-invites";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
installSesMailFixture().configure();
const ORIGIN = "https://marktmorgen.com";
const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const form = (email: string, session: string) =>
  new NextRequest(`${ORIGIN}/api/store/address`, {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", cookie: `${SESSION_COOKIE}=${session}` },
    body: new URLSearchParams({ email }),
  });
const said = async (email: string, session: string) => (((await addressRoute(form(email, session))).headers.get("location") ?? "").split("address=")[1] ?? "");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("prober@move-enum.example", "move-prober", "Prober", "");
  await claimHandle("creator@move-enum.example", "move-creator", "Creator", "");

  part("A session that is not recent learns nothing about the address");
  const stale = await openSession("prober@move-enum.example");
  await redis.pipeline([["DEL", `nl:auth:fresh:${hex(`nimbus-auth-fresh:${stale}`).slice(0, 40)}`]]);
  const known = await said("creator@move-enum.example", stale);
  const unknown = await said("nobody@move-enum.example", stale);
  is("an address with a store and one without get the same answer: log in again", [known, unknown], ["reauth", "reauth"]);

  part("A recent session asks inside the account's five addresses an hour, whatever the answer");
  const fresh = await openSession("prober@move-enum.example");
  const answers: string[] = [];
  for (let i = 0; i < 8; i += 1) answers.push(await said("creator@move-enum.example", fresh));
  is("five answers, then limited: asking about a store counts as an ask", answers, ["taken", "taken", "taken", "taken", "taken", "limited", "limited", "limited"]);
  is("an address without a store is limited the same, past the five", await said("nobody@move-enum.example", fresh), "limited");

  part("Inviting a partner answers the same whether or not the address has a store (rule 30)");
  const owner = "maker@move-enum.example";
  await claimHandle(owner, "move-maker", "Maker", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1movemakerxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_movemaker", subscriptionId: "sub_movemaker", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Bread Basics", "", "40");
  const product = made.ok ? made.product.id : "";
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest(`${ORIGIN}/api/store/affiliates`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  is("(the program is on)", (await post({ action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 5, days: 60, rates: {} })).body.ok, true);
  const here = await post({ action: "invite", email: "creator@move-enum.example", percent: 10, products: [product] });
  const away = await post({ action: "invite", email: "stranger@move-enum.example", percent: 10, products: [product] });
  is("both invitations answered alike", [here.status, JSON.stringify(here.body)], [away.status, JSON.stringify(away.body)]);
  is("and the answer is a plain yes", here.body, { ok: true });

  part("A studio with twenty offers waiting answers the same as an inbox (pre-review D)");
  const crowded = "crowded@move-enum.example";
  await claimHandle(crowded, "move-crowded", "Crowded", "");
  for (let i = 0; i < 20; i += 1) {
    await offerPartnership(crowded, { sid: `other${i}`.padEnd(12, "x"), storeName: `Other ${i}`, handle: `other${i}`, share: { percent: 10, products: [product] }, titles: ["x"] });
  }
  const full = await post({ action: "invite", email: crowded, percent: 10, products: [product] });
  const plain = await post({ action: "invite", email: "stranger2@move-enum.example", percent: 10, products: [product] });
  is("the same answer as an address with no store", [full.status, JSON.stringify(full.body)], [plain.status, JSON.stringify(plain.body)]);
  is("and no twenty-first offer is left in that studio", (await waitingFor(crowded)).length, 20);
  done();
}

void main();
