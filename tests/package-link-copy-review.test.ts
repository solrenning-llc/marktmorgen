/**
 * The thanks page renders packageSameLink even when recordPackage did not
 * reach the sender. Copy without a delivery outcome must not say an attempt
 * happened.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordPackage } from "@/lib/call-packages";
import { thanksWords } from "@/lib/buyer-words/thanks";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_packages_only";

  let senderRequests = 0;
  globalThis.fetch = (async () => {
    senderRequests += 1;
    return new Response(JSON.stringify({ id: "unexpected" }), { status: 200 });
  }) as typeof fetch;

  part("A paid package can reach the page without an email attempt");
  const bought = await recordPackage({
    store: {
      statsId: "stats-review-package-copy",
      handle: "harbor",
      language: "en",
      currency: "usd",
    } as Store,
    product: { id: "product-review-package-copy" } as Listing,
    base: "https://marktmorgen.com/@harbor",
    from: '"Harbor Kitchen" <hello@marktmorgen.com>',
    session: {
      id: `cs_test_${"m".repeat(24)}`,
      status: "complete",
      payment_status: "paid",
      amount_total: 50000,
      currency: "usd",
      metadata: { kind: "package", sessions: "5", days: "90" },
      customer_details: null,
    },
  });
  is("no package record without a buyer address", bought, null);
  is("the sender was not attempted", senderRequests, 0);

  part("The page still renders the note without evidence of an attempt");
  const page = readFileSync(join(process.cwd(), "app/[handle]/thanks/page.tsx"), "utf8");
  is("the package email note is unconditional", page.includes("{t.packageSameLink(order.email ?? t.theAddressYouPaidWith)}"), true);
  is("the unconditional note does not claim an attempt happened", thanksWords("en").packageSameLink("the address used to pay").includes("tried to email"), false);

  done();
}

void main();
