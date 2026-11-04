/**
 * A booking block is kept and drawn but not offered yet (552 [BB1] unit 1;
 * review of #2145, inbox C4-17): the route that saves a product's page
 * refuses one in either version, so a hand-made request cannot put any id
 * on a page, while the same page without it is saved.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId } from "@/lib/store";
import { POST as savePage } from "@/app/api/store/page/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "booking.maker@example.com";
const ORIGIN = "https://marktmorgen.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "bookingshop", "Booking Shop", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Guide", "", "29", null);
  if (!made.ok) throw new Error("no product");
  const session = await openSession(OWNER);
  const save = async (page: unknown) => {
    const response = await savePage(
      new NextRequest(`${ORIGIN}/api/store/page`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ id: made.product.id, page }),
      }),
    );
    return [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? ""];
  };
  const text = { id: "text0001", kind: "text", heading: "Why", body: "Because." };
  const booking = { id: "book0001", kind: "booking", product: "c".repeat(10), heading: "Talk first" };

  part("The page route and the booking block");
  is("a page with a booking block is refused", await save({ blocks: [text, booking] }), [400, "kind"]);
  is("in the second version too", await save({ blocks: [text], variant: { id: "", blocks: [{ ...text, heading: "Why not" }, booking] } }), [400, "kind"]);
  const [status] = await save({ blocks: [text] });
  is("the same page without it is saved", status, 200);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
