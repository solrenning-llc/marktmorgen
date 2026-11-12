/**
 * A partner buying their own product is not a sale, however the address is written.
 *
 * notePartners marked a partner's own purchase only when the buyer's address was
 * the partner's letter for letter (lower-cased). Every other self check of the
 * programme (isSelf for the affiliate's line, the recurring lines) compares one
 * inbox with canonicalEmail: without a "+" tag, and for Gmail without its dots
 * and with googlemail.com as gmail.com. So a partner holding 50% of a product
 * could buy it as "jane.doe+me@gmail.com" against "janedoe@gmail.com" and earn a
 * share of their own purchase. Each written line must say `self`.
 */
import { notePartners } from "@/lib/affiliates";
import type { Affiliate } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "5a7151d2".repeat(4);
const PARTNER = "0123456789cd";

function shop(): Store {
  return {
    sid: "sidharbor02",
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    affiliates: { enabled: true, percent: 20, days: 30, rates: {}, payday: 0, hold: 0 },
  } as unknown as Store;
}

function partner(email: string): Affiliate {
  return { id: PARTNER, email, code: "jane", status: "approved", appliedAt: 1, decidedAt: 2, note: "", share: { percent: 50, products: ["course"] } } as unknown as Affiliate;
}

async function selfOf(partnerEmail: string, buyer: string, ref: string): Promise<unknown> {
  await notePartners(shop(), { ref, pi: `pi_${ref}`, at: 1_700_000_000_000, product: "course", title: "Course", base: 10_000, total: 10_000, currency: "usd", buyer }, [partner(partnerEmail)]);
  const raw = (await redis.pipeline([["HGET", `nl:aff:${STATS}:shares`, `${ref}:${PARTNER}`]]))[0];
  return typeof raw === "string" ? JSON.parse(raw).self : `missing: ${String(raw)}`;
}

async function main(): Promise<void> {
  redis.clear();
  is("the same address is the partner's own purchase", await selfOf("janedoe@gmail.com", "janedoe@gmail.com", "cs_a"), true);
  is("a + tag is still the partner", await selfOf("janedoe@gmail.com", "janedoe+me@gmail.com", "cs_b"), true);
  is("Gmail's dots are still the partner", await selfOf("janedoe@gmail.com", "Jane.Doe@gmail.com", "cs_c"), true);
  is("googlemail.com is gmail.com", await selfOf("jane.doe@gmail.com", "janedoe@googlemail.com", "cs_d"), true);
  is("a trailing dot on the domain is the same inbox", await selfOf("jane@example.com", "jane+x@example.com.", "cs_e"), true);
  is("somebody else is a sale", await selfOf("janedoe@gmail.com", "johndoe@gmail.com", "cs_f"), false);
  is("dots outside Gmail are a different inbox", await selfOf("jane.doe@example.com", "janedoe@example.com", "cs_g"), false);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
