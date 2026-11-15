/**
 * The free-copy form counts one connection by its share address, an IPv6 /48 (#4626, first part).
 *
 * app/api/store/free/route.ts handed requestCopy the raw x-forwarded-for, and lib/free.ts paces 20 copies an hour
 * per address and store. Every address of a /48 is then its own allowance, so one machine with a /48 of its own (a
 * free tunnel hands one out) asked for copies as fast as it liked: each counted on the month's orders figure the paid
 * orders share (lib/order-rules.ts), and each sent an email from Marktmorgen's account to an address it chose. The
 * route now counts the connection as the calendar and join routes do (shareAddress: an IPv6 /48, an IPv4 as it is).
 * The per-store cap on free copies is the owner's decision (it touches the plan's orders figure) and is not here.
 *
 * Synthetic store and product; Resend is a stand-in; MemoryRedis. The route's answer (status=limited) is what is
 * checked: the pace is taken before any email is sent or any order counted.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductLink, setSubscription } from "@/lib/store";
import { POST as freeRoute } from "@/app/api/store/free/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let mails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    mails += 1;
    return new Response(JSON.stringify({ id: `email_${mails}` }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ask = (product: string, email: string, ip: string) =>
  freeRoute(
    new NextRequest("https://marktmorgen.com/api/store/free", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", host: "marktmorgen.com", origin: "https://marktmorgen.com", "x-forwarded-for": ip },
      body: new URLSearchParams({ handle: "freeharbor", product, email }).toString(),
    }),
  );

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_free_copy_connection_only";
  const owner = "owner-free@example.com";
  await claimHandle(owner, "freeharbor", "Free Harbor", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_FreeCopyConnection01", subscriptionId: "sub_FreeCopyConnection01", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "The Free Guide", "", "0", null);
  if (!made.ok) throw new Error("no product");
  const product = made.product.id;
  await setProductLink(owner, product, "https://example.com/free-guide.pdf");

  part("Thirty asks from thirty addresses of one /48, each with a new email");
  const status = (response: Response) => new URL(response.headers.get("location") ?? "https://x/").searchParams.get("status");
  const quiet = console.error;
  console.error = () => {};
  const answers: (string | null)[] = [];
  try {
    for (let i = 0; i < 30; i += 1) answers.push(status(await ask(product, `reader${i}@example.com`, `2001:db8:77:${(i + 1).toString(16)}::1`)));
  } finally {
    console.error = quiet;
  }
  // lib/free.ts allows one connection 20 asks an hour, counted before anything is sent or counted on the month.
  is("the first 20 are let through to the copy", answers.slice(0, 20).every((a) => a !== "limited"), true);
  is("and the next 10 from the same /48 are limited", answers.slice(20).every((a) => a === "limited"), true);

  part("Control: another connection is not limited");
  console.error = () => {};
  try {
    is("an ask from another address", status(await ask(product, "someone-else@example.com", "198.51.100.7")) !== "limited", true);
  } finally {
    console.error = quiet;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
