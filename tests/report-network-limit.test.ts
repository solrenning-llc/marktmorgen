/**
 * MM-SA-36 (docs/security-audit-2026-10-28.md): the public notice form
 * (/api/report) was paced only per exact client address. One machine is handed a whole IPv6
 * /64 (2^64 addresses), so it can file notices without limit: each one is a
 * company-metered email to the support inbox (no ceiling), a record kept 400
 * days and one more on the public transparency count. Now five an hour per
 * network (IPv6 by its /48, IPv4 by its address): the sixth from the same
 * network is refused and nothing more is emailed, while another network and
 * an IPv4 sender are untouched.
 * Synthetic data only; Resend is a stand-in.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/report/route";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const sent: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const NOTICE = {
  kind: "copyright",
  url: "https://marktmorgen.com/@noticeshop",
  work: "My song, played on this page from an upload I did not make.",
  original: "https://example.com/song",
  name: "Rita Owner",
  email: "rita@example.com",
  contact: "+1 555 0100",
  signature: "Rita Owner",
  goodFaith: true,
  accurate: true,
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";
  const file = (address: string) =>
    POST(new NextRequest("https://marktmorgen.com/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": address, "sec-fetch-site": "same-origin" },
      body: JSON.stringify(NOTICE),
    }));
  const statuses: number[] = [];
  for (let i = 1; i <= 8; i++) { const r = await file(`2001:db8:1:2::${i.toString(16)}`); statuses.push(r.status); }
  is("the first five from one /64 are taken", statuses.slice(0, 5), [200, 200, 200, 200, 200]);
  is("the rest from the same /64 are refused (429)", statuses.slice(5), [429, 429, 429]);
  is("only five emails reached the support inbox", sent.length, 5);
  is("another network is not held back by it", (await file("2001:db8:2:1::1")).status, 200);
  is("nor is an IPv4 sender", (await file("203.0.113.7")).status, 200);
  done();
}

void main();
