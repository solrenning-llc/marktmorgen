/**
 * Launching a waitlist emails every confirmed address on it, with a note the studio types
 * (lib/waitlist.ts launch). That is sending to a list, so it needs "send" (lib/team-roles.ts:
 * an Editor has "No sending to the list"; the other email to a product's people,
 * app/api/store/product-update, already asks for "send"). Marking a product coming soon or
 * not stays "products". Audit of the API routes, Claude 3 (cloud K), 11 November 2026.
 *
 * Synthetic store and team; no network.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { isSoon, joinWaitlist, setSoon } from "@/lib/waitlist";
import { putMember } from "@/lib/team";
import { POST as waitlistRoute } from "@/app/api/store/waitlist/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_launch";
  const owner = "k-launch-owner@example.com";
  const editor = "k-launch-editor@example.com";
  await claimHandle(owner, "klaunch", "K Launch", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  const made = await addProduct(owner, "The Soon Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;
  if (!(await putMember(store, editor, "editor"))) throw new Error("no editor");
  await setSoon(store, product.id, true);
  await joinWaitlist({ store, product, email: "dana@example.com", consent: false, ip: "1.1.1.1", origin: "https://marktmorgen.com" });

  const post = async (who: string, body: Record<string, unknown>) => {
    const session = await openSession(who);
    const response = await waitlistRoute(
      new NextRequest(`https://marktmorgen.com/api/store/waitlist?store=${store.sid}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ id: product.id, ...body }),
      }),
    );
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
  };

  part("An Editor may mark a product coming soon, as before");
  const marked = await post(editor, { action: "soon", on: true });
  is("coming soon: allowed for an Editor", marked.status, 200);

  part("An Editor may not launch: that emails the whole waitlist");
  const launched = await post(editor, { action: "launch", note: "Typed by an editor", address: "" });
  is("refused", launched.status, 403);
  is("refused for the role (\"role\", lib/studio-route.ts refusedJson), not for the second step", launched.body?.error, "role");
  is("the product is still coming soon: nothing was launched", await isSoon(store, product.id), true);

  part("Control: the owner, with the same kind of session, launches");
  const own = await post(owner, { action: "launch", note: "", address: "" });
  is("the owner's launch goes through", [own.status, own.body?.ok], [200, true]);
  is("and the product is no longer coming soon", await isSoon(store, product.id), false);
  done();
}

void main();
