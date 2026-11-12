/**
 * Reviewer RED for #2523: an untrusted status URL must not name a draft on
 * the public wait-list page merely because its product id is known.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import WaitlistPage from "@/app/[handle]/waitlist/page";
import { addProduct, claimHandle, setProductHidden } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

async function main(): Promise<void> {
  redis.clear();
  const owner = "reviewer-waitlist@example.test";
  await claimHandle(owner, "reviewerwaitlist", "Reviewer Waitlist", "");
  const made = await addProduct(owner, "Unpublished reviewer course", "", "0", null);
  if (!made.ok) throw new Error("product fixture was not created");
  const hidden = await setProductHidden(owner, made.product.id, true);
  if (!hidden.ok) throw new Error(`product fixture was not hidden: ${hidden.reason}`);
  answering(new NextRequest(`https://marktmorgen.com/@reviewerwaitlist/waitlist?status=sent&product=${made.product.id}`));

  const node = await WaitlistPage({
    params: Promise.resolve({ handle: "@reviewerwaitlist" }),
    searchParams: Promise.resolve({ status: "sent", product: made.product.id }),
  });
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  const html = await new Response(stream).text();

  part("A draft remains unknown on the public wait-list status page");
  is("the page does not print the draft title", html.includes("Unpublished reviewer course"), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
