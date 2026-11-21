/**
 * The free-copy form counts one connection by its /64, and a whole IPv6 /48 by a looser count of its own (#4626,
 * first part; Claude 7 on #4636).
 *
 * app/api/store/free/route.ts handed requestCopy the raw x-forwarded-for, and lib/free.ts paces 20 copies an hour
 * per address and store. Every address of an IPv6 network was then its own allowance, so one machine with a network
 * of its own asked for copies as fast as it liked: each counted on the month's orders figure the paid orders share
 * (lib/order-rules.ts), and each sent an email to an address it chose. The 20 an hour now count a connection's /64
 * (the least one customer is handed), never a /48, which a mobile carrier shares among thousands of subscribers; and
 * a whole /48, which a tunnel hands one person with 65,536 /64s in it, at most 200 copies of a store an hour. The
 * per-store cap on free copies is the owner's decision (it touches the plan's orders figure) and is not here.
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
  let product = made.product.id;
  await setProductLink(owner, product, "https://example.com/free-guide.pdf");

  const status = (response: Response) => new URL(response.headers.get("location") ?? "https://x/").searchParams.get("status");
  const quiet = console.error;
  const asks = async (ips: string[]): Promise<(string | null)[]> => {
    console.error = () => {};
    try {
      const out: (string | null)[] = [];
      for (const [i, ip] of ips.entries()) out.push(status(await ask(product, `reader${mails}-${i}-${ip.length}@example.com`, ip)));
      return out;
    } finally {
      console.error = quiet;
    }
  };

  part("Thirty asks from thirty addresses of one /64, each with a new email");
  const one = await asks(Array.from({ length: 30 }, (_, i) => `2001:db8:77:1:${(i + 1).toString(16)}::1`));
  // lib/free.ts allows one connection 20 asks an hour, counted before anything is sent or counted on the month.
  is("the first 20 are let through to the copy", one.slice(0, 20).every((a) => a !== "limited"), true);
  is("and the next 10 from the same /64 are limited", one.slice(20).every((a) => a === "limited"), true);

  part("Another subscriber of the same carrier /48");
  is("another /64 of that /48 keeps its own 20 (Claude 7 on #4636)", (await asks(["2001:db8:77:beef::9"]))[0] !== "limited", true);

  part("One phone asking 200 times never locks its carrier's other subscribers out");
  const phone = await asks(Array.from({ length: 200 }, (_, i) => `2001:db8:78:1:${(i + 1).toString(16)}::1`));
  is("its own 20 go through, the rest are limited", [phone.slice(0, 20).every((a) => a !== "limited"), phone.slice(20).every((a) => a === "limited")], [true, true]);
  is("and a neighbour /64 of the same /48 still gets its copy (Claude 6 on #4636)", (await asks(["2001:db8:78:beef::9"]))[0] !== "limited", true);

  part("A whole /48 asking from a new /64 each time");
  redis.clear();
  await claimHandle(owner, "freeharbor", "Free Harbor", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_FreeCopyConnection01", subscriptionId: "sub_FreeCopyConnection01", active: true, period: paidPeriod() });
  const remade = await addProduct(owner, "The Free Guide", "", "0", null);
  if (!remade.ok) throw new Error("no product");
  product = remade.product.id;
  await setProductLink(owner, product, "https://example.com/free-guide.pdf");
  const net = await asks(Array.from({ length: 205 }, (_, i) => `2001:db8:99:${(i + 1).toString(16)}::1`));
  is("200 of the store's copies an hour for the whole /48, then limited", [net.slice(0, 200).filter((a) => a === "limited").length, net.slice(200).every((a) => a === "limited")], [0, true]);

  part("Control: another connection is not limited");
  is("an ask from another address", (await asks(["198.51.100.7"]))[0] !== "limited", true);
  const v4 = await asks([...Array.from({ length: 20 }, () => "::ffff:198.51.100.9"), "198.51.100.9"]);
  is("an IPv4 address written the new way is the same connection", [v4.slice(0, 20).every((a) => a !== "limited"), v4[20]], [true, "limited"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
