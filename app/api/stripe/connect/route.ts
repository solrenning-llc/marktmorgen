import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { away, creatorFrom } from "@/lib/studio-route";
import {
  StripeConnectError,
  createConnectedAccount,
  createOnboardingLink,
  isConnectConfigured,
  normaliseCountry,
} from "@/lib/stripe-connect";
import { setStripeAccount } from "@/lib/store";
import { limited } from "@/lib/request-guard";

/**
 * Sends the creator into Stripe to open or attach their own account.
 *
 * The account is opened once and written down before the creator leaves, so a
 * trip that is abandoned halfway does not leave an account behind that nobody
 * here knows about.
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "payments");
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;

  if (!isConnectConfigured()) return away(origin, studio("stripe=unavailable"));

  let country = "";
  try {
    const form = await (await limited(request, 8_000)).formData();
    const value = form.get("country");
    country = typeof value === "string" ? normaliseCountry(value) : "";
  } catch {
    country = "";
  }

  // Only needed the first time: after that the account exists and its country
  // is fixed, so asking again would suggest it can still be changed.
  if (!store.stripeAccountId && !country) {
    return away(origin, studio("stripe=country"));
  }

  try {
    let accountId = store.stripeAccountId;
    if (!accountId) {
      accountId = await createConnectedAccount({
        email: store.email,
        country,
        displayName: store.name || store.handle,
      });
      const saved = await setStripeAccount(ref, accountId);
      if (!saved.ok) return away(origin, studio("stripe=error"));
      // Where sales are paid is the setting worth stealing a session for, so
      // the creator is told at their sign-in address (lib/account-notice.ts).
      after(() => noticeCreator(store, { kind: "stripe-connected" }));
    }

    const link = await createOnboardingLink(accountId, origin, store.sid);
    return new Response(null, { status: 303, headers: { Location: link } });
  } catch (error) {
    console.error("stripe connect failed", error);
    // Worth its own answer: nothing the creator does will fix this one, and a
    // vague "try again" would have them trying forever.
    if (error instanceof StripeConnectError && error.isCrossBorderRefusal) {
      return away(origin, studio("stripe=country-unsupported"));
    }
    return away(origin, studio("stripe=error"));
  }
}
