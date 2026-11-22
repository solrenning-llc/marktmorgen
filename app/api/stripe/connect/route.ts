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
import { beginStripeConnect, clearStripeConnect, finishStripeConnect, storeForEmail } from "@/lib/store";
import { limited } from "@/lib/request-guard";

/**
 * Sends the creator into Stripe to open or attach their own account.
 *
 * The account is opened once and written down before the creator leaves, so a
 * trip that is abandoned halfway does not leave an account behind that nobody
 * here knows about. The attempt is written on the store before Stripe is asked,
 * and Stripe is asked with its idempotency key (Codex L-20261120-0258): an answer
 * lost on the way is found again by pressing once more, two tabs get one account,
 * and the store is not deleted while Stripe may hold one only it can name.
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
      // The store's open attempt, or a new one written down first, with what Stripe is asked with.
      const attempt = await beginStripeConnect(ref, store.sid, { country, email: store.email, name: store.name || store.handle });
      if (!attempt) {
        // Another tab finished first: the account it wrote is the store's; otherwise nothing is known.
        const now = await storeForEmail(ref);
        if (now?.sid !== store.sid || !now.stripeAccountId) return away(origin, studio("stripe=error"));
        accountId = now.stripeAccountId;
      } else {
        try {
          accountId = await createConnectedAccount({
            email: attempt.email,
            country: attempt.country,
            displayName: attempt.name,
            idempotencyKey: `connect-${store.sid}-${attempt.id}`,
          });
        } catch (error) {
          // Only a refusal that says nothing was made closes the attempt; anything else keeps it for the next press.
          if (error instanceof StripeConnectError && error.madeNothing) await clearStripeConnect(ref, store.sid, attempt.id).catch(() => false);
          throw error;
        }
        // Written with the attempt closed, only while it is still the store's: when two tabs connect at once they ask
        // with one key and get one account; the late tab finds it written and goes on with it.
        const saved = await finishStripeConnect(ref, store.sid, attempt.id, accountId);
        if (saved) {
          // Where sales are paid is the setting worth stealing a session for, so the creator is told at their
          // sign-in address (lib/account-notice.ts), once: by the request that wrote the account.
          after(() => noticeCreator(store, { kind: "stripe-connected" }));
        } else {
          const now = await storeForEmail(ref);
          if (now?.sid !== store.sid || now.stripeAccountId !== accountId) return away(origin, studio("stripe=error"));
        }
      }
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
