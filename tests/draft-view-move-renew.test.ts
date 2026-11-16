/** Reviewer RED for #2523: invalid public URLs must not name a draft. */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import MovePage from "@/app/[handle]/move/[product]/page";
import RenewPage from "@/app/[handle]/renew/[product]/page";
import { addProduct, claimHandle, setProductHidden } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

async function html(node: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "reviewer-draft-pages@example.test";
  await claimHandle(owner, "reviewerdraftpages", "Reviewer Draft Pages", "");
  const made = await addProduct(owner, "Unpublished migration membership", "", "19", null);
  if (!made.ok) throw new Error("product fixture was not created");
  const hidden = await setProductHidden(owner, made.product.id, true);
  if (!hidden.ok) throw new Error(`product fixture was not hidden: ${hidden.reason}`);

  part("A known draft id without a valid private grant remains unknown");
  answering(new NextRequest(`https://marktmorgen.com/@reviewerdraftpages/move/${made.product.id}`));
  const move = await html(await MovePage({
    params: Promise.resolve({ handle: "@reviewerdraftpages", product: made.product.id }),
    searchParams: Promise.resolve({}),
  }) as React.ReactElement);
  is("an invalid migration URL does not print the draft title", move.includes("Unpublished migration membership"), false);

  answering(new NextRequest(`https://marktmorgen.com/@reviewerdraftpages/renew/${made.product.id}`));
  const renew = await html(await RenewPage({
    params: Promise.resolve({ handle: "@reviewerdraftpages", product: made.product.id }),
    searchParams: Promise.resolve({}),
  }) as React.ReactElement);
  is("an invalid renewal URL does not print the draft title", renew.includes("Unpublished migration membership"), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
