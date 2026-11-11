/**
 * 251 [ST4], unit 4: a product's delivery link taken in the add step, so the
 * first product can sell without a second action (docs/signup-to-ready-measured.md,
 * candidate 2). Through the real route, on the in-memory Redis.
 *
 *   - added with a link: kept, and the product has something to hand over;
 *   - a link that is not one (readLink refuses it): the whole add is refused,
 *     nothing is written, the same answer the link action gives;
 *   - added without a link: as before, nothing to hand over yet.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { handsOver } from "@/lib/product-option";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => { throw new Error("No external provider in this proof"); }) as typeof fetch;

const owner = "adder@example.com";
const post = (session: string, body: Record<string, unknown>) =>
  POST(new NextRequest("https://marktmorgen.com/api/store/product", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
    body: JSON.stringify(body),
  }));

(async () => {
  redis.clear();
  await claimHandle(owner, "adder-shop", "Adder", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  const session = await openSession(owner);
  const listings = async () => readListings((await storeForEmail(owner))!);

  part("Added with what it delivers");
  const added = await post(session, { action: "add", title: "Field notes", price: "19", link: "https://example.com/field-notes.pdf" });
  is("added", added.status, 200);
  const [one] = await listings();
  is("it keeps the link", one?.link, "https://example.com/field-notes.pdf");
  is("and has something to hand over", one ? handsOver(one) : null, true);

  part("A link that is not one: nothing added");
  const refused = await post(session, { action: "add", title: "Second", price: "9", link: "javascript:alert(1)" });
  is("refused as a link", [refused.status, ((await refused.json()) as { error?: string }).error], [400, "link"]);
  is("no product was written", (await listings()).map((l) => l.title), ["Field notes"]);

  part("Added without one: as before");
  is("added", (await post(session, { action: "add", title: "Third", price: "9" })).status, 200);
  const third = (await listings()).find((l) => l.title === "Third");
  is("nothing to hand over yet", third ? handsOver(third) : null, false);

  done();
})();
