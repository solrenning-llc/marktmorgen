/**
 * A list's cursor that the list could not have given (letters, a minus sign, a fraction, more digits than it ever
 * gives) used to start the list again in silence: products, the list, members and a course's students answered the
 * first page with a next, so a sync holding a damaged cursor looped without knowing. /api/v1/sales already answers 400
 * invalid_cursor; every list now does, before anything further is read or taken. No cursor (or an empty one) still
 * starts the list, and a cursor the list gave still reads its page. Also, the developers page's example of the
 * `fields` error is the message the code sends.
 */
import { readFileSync } from "node:fs";
import { makeKey } from "@/lib/api-keys";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setCommunity, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { badFields, FIELD_NAME_MAX, MAX_FIELDS_ASKED } from "@/lib/api-fields";
import { GET as getProducts } from "@/app/api/v1/products/route";
import { GET as getLeads } from "@/app/api/v1/leads/route";
import { GET as getMembers } from "@/app/api/v1/members/route";
import { GET as getStudents } from "@/app/api/v1/students/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async (input: string | URL | Request) => {
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${String(input)}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "cursor@example.com";
  await claimHandle(OWNER, "cursorshop", "Cursor Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Cursor00001", subscriptionId: "sub_Cursor00001", active: true, period: paidPeriod() });
  for (let i = 0; i < 3; i += 1) {
    const made = await addProduct(OWNER, `Guide ${i}`, "", "12", null);
    if (!made.ok) throw new Error("product fixture");
    await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  }
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const reader = await makeKey(store.sid!, "Sync");
  if (!reader.ok) throw new Error("no key");
  const get = async (handler: (r: Request) => Promise<Response>, path: string) => {
    const response = await handler(new Request(`https://marktmorgen.com${path}`, { headers: { Authorization: `Bearer ${reader.key}` } }));
    return { status: response.status, json: (await response.json()) as { error?: string; data?: unknown[]; next?: string | null } };
  };

  const doors: [string, (r: Request) => Promise<Response>, string][] = [
    ["products", getProducts, "/api/v1/products"],
    ["the list", getLeads, "/api/v1/leads"],
    ["members", getMembers, "/api/v1/members"],
    ["a course's students", getStudents, "/api/v1/students?product=nothing"],
  ];
  const join = (path: string, q: string) => `${path}${path.includes("?") ? "&" : "?"}${q}`;
  for (const [name, handler, path] of doors) {
    part(`A cursor ${name} never gave is answered 400`);
    for (const bad of ["abc", "-1", "1.5", "1".repeat(21)]) {
      const answered = await get(handler, join(path, `cursor=${encodeURIComponent(bad)}`));
      is(`cursor=${bad.length > 8 ? `${bad.slice(0, 4)}… (${bad.length} digits)` : bad}`, [answered.status, answered.json.error], [400, "invalid_cursor"]);
    }
  }

  part("No cursor, an empty one, or one the list gave still reads");
  is("products, from the start", (await get(getProducts, "/api/v1/products")).json.data?.length, 3);
  is("an empty cursor starts the list", (await get(getProducts, "/api/v1/products?cursor=")).json.data?.length, 3);
  is("a cursor past the end is an empty last page", [(await get(getProducts, "/api/v1/products?cursor=20")).status, (await get(getProducts, "/api/v1/products?cursor=20")).json.next], [200, null]);
  is("the list, from Redis's own cursor", (await get(getLeads, "/api/v1/leads?cursor=0")).status, 200);

  part("The developers page shows the `fields` error the code sends");
  const sent = badFields(new Request("https://marktmorgen.com/api/v1/products?fields=bad-name"));
  const message = sent ? ((await sent.json()) as { message: string }).message : "";
  const asWritten = message.replace(String(FIELD_NAME_MAX), "${FIELD_NAME_MAX}").replace(String(MAX_FIELDS_ASKED), "${MAX_FIELDS_ASKED}");
  const page = readFileSync("app/developers/page.tsx", "utf8");
  is("the example is the message, word for word", page.includes(`{"error": "fields", "message": "${asWritten}"}`), true);
  is("and nowhere names the old words", page.includes("Use letters, digits and underscores, at most 30 fields."), false);
  is("a cursor the list did not give is said, for every list", page.includes("A cursor a list did not give is answered 400"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
