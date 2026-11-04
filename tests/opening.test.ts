/**
 * Not open yet.
 *
 * Marktmorgen is still being built (5 October 2026), and the site was taking
 * a card for a 14-day trial as if it were finished. One constant now says
 * whether a plan can be started (lib/opening.ts). While it cannot:
 *
 *   - the checkout that starts a plan refuses, without asking Stripe for
 *     anything, and a store is left exactly as it was;
 *   - the studio shows the reason where the buttons were;
 *   - every public page says so at its top, and no button promises free days
 *     that cannot be started;
 *   - the mission page counts starting a plan as not built.
 *
 * Written against the constant, so the day it is changed to `true` this
 * file checks the other half instead of failing.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as switchBilling } from "@/app/api/billing/switch/route";
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { HOME_QUESTIONS } from "@/lib/home-faq";
import { PLANS_ON_SALE, PREVIEW_LINE, PREVIEW_LINK, startWords } from "@/lib/opening";
import { TRIAL_DAYS } from "@/lib/plan";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOST = "marktmorgen.com";

const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  asked.push(`${url.hostname}${url.pathname}`);
  if (url.pathname.endsWith("/checkout/sessions")) {
    return new Response(JSON.stringify({ id: "cs_test_a1b2c3d4e5f6g7h8", url: "https://checkout.stripe.com/c/pay/cs_test_a1b2c3d4e5f6g7h8" }), { status: 200 });
  }
  return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_notARealKeyOnlyForTheseChecks";
  redis.clear();

  part("Starting a plan");
  const claimed = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!claimed.ok) throw new Error("no store");
  const shop = (await storeForEmail("owner@example.com"))!;
  const session = await openSession("owner@example.com");
  const before = JSON.stringify(await storeForEmail("owner@example.com"));
  const press = () =>
    checkout(
      new NextRequest(`https://${HOST}/api/billing/checkout?store=${shop.sid}`, {
        method: "POST",
        headers: { host: HOST, origin: `https://${HOST}`, cookie: `${SESSION_COOKIE}=${session}`, "content-type": "application/x-www-form-urlencoded" },
        body: "cycle=month",
      }),
    );
  const pressed = await press();
  const where = pressed.headers.get("location") ?? "";
  if (PLANS_ON_SALE) {
    is("open: the creator is sent to pay", [pressed.status, where.includes("billing=not-open")], [303, false]);
  } else {
    is("not open: sent back to the studio, told why", [pressed.status, where.includes("/studio"), where.includes("billing=not-open")], [303, true, true]);
    is("Stripe is asked for nothing", asked.filter((a) => a.includes("stripe")), []);
    is("and the store is exactly as it was", JSON.stringify(await storeForEmail("owner@example.com")), before);
  }

  if (!PLANS_ON_SALE) {
    part("A closed commercial release cannot be bypassed by switching plans");
    await setSubscription("owner@example.com", { active:true, customerId:"cus_MarginOwner0001", subscriptionId:"sub_MarginOwner0001", tier:"creator", cycle:"month", trialEnds:0 });
    const beforeSwitch=JSON.stringify(await storeForEmail("owner@example.com"));
    asked.length=0;
    const switched=await switchBilling(new NextRequest(`https://${HOST}/api/billing/switch?store=${shop.sid}`,{
      method:"POST",
      headers:{host:HOST,origin:`https://${HOST}`,cookie:`${SESSION_COOKIE}=${session}`,"content-type":"application/x-www-form-urlencoded"},
      body:"tier=pro&cycle=year",
    }));
    is("switch stays closed",[switched.status,(switched.headers.get("location")??"").includes("billing=not-open")],[303,true]);
    is("switch asks Stripe for nothing",asked.filter(a=>a.includes("stripe")),[]);
    is("existing subscription record unchanged",JSON.stringify(await storeForEmail("owner@example.com")),beforeSwitch);
  }

  part("What the studio shows in its place");
  const studio = readFileSync("app/studio/page.tsx", "utf8");
  is("the notice for a press that was refused", studio.includes('"not-open": {') && studio.includes("Plans are not on sale yet"), true);
  is("the reason stands where the buttons were", studio.includes(") : !PLANS_ON_SALE ? (") && studio.includes('data-plans-closed=""'), true);
  is("no first step asks for a plan that cannot be started", studio.includes("billingReadyForSteps && (PLANS_ON_SALE || paid)"), true);

  part("What every public page says");
  const nav = readFileSync("components/site-nav.tsx", "utf8");
  is("the line is above the menu, only while it is true", nav.includes("{PLANS_ON_SALE ? null : (") && nav.includes('data-preview-bar=""') && nav.includes("{PREVIEW_LINE}"), true);
  is("it names what can be done and what cannot", [PREVIEW_LINE.includes("still being built"), PREVIEW_LINE.includes("open a store"), PREVIEW_LINE.includes("not on sale yet")], [true, true, true]);
  is("and leads to both lists", PREVIEW_LINK.href, "/mission");
  is("the way past the menu is still the first thing a keyboard reaches", nav.indexOf("Skip to the page content") < nav.indexOf("data-preview-bar"), true);

  part("No promise of free days that cannot be started");
  is("the button to a new store", startWords(TRIAL_DAYS), PLANS_ON_SALE ? `Try it free for ${TRIAL_DAYS} days` : "Start your store");
  const pages = ["app/platform/page.tsx", "components/topic-page.tsx"].map((f) => readFileSync(f, "utf8"));
  is("feature pages take their button from it", pages.map((p) => p.includes("{startWords(TRIAL_DAYS)}") && !p.includes("{`Try it free for")), [true, true]);
  const first = HOME_QUESTIONS.find((item) => item.q === "Can I start selling today?")!;
  is("the home page is asked whether selling starts today", Boolean(first), true);
  is("and answers with what is true", first.a.startsWith("Yes.") === PLANS_ON_SALE && first.a.includes("not on sale yet") !== PLANS_ON_SALE, true);
  // 243 [CF6], owner's complement of 31/10/2026: said once, right above the plans, not again in each card.
  is("the pricing page says it once, above the plans", /\{!PRICING_OPEN && <p[^>]*>Paid plans and paid selling are not open yet\./.test(readFileSync("app/pricing/page.tsx", "utf8")), true);
  is("and so do the home page and the page where a store is started", ["app/page.tsx", "app/signin/page.tsx"].map((f) => readFileSync(f, "utf8").includes("PLANS_ON_SALE")), [true, true]);

  part("The mission page");
  const mission = readFileSync("app/mission/page.tsx", "utf8");
  is("a plan nobody can start is not counted as built", mission.includes("const billing = billingReached && PLANS_ON_SALE;"), true);
  is("and is named among what is not, as written and not on sale", mission.includes("billingReached ? BILLING_CLOSED_LINE : BILLING_LINE") && mission.includes("it is not on sale until Marktmorgen opens"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
