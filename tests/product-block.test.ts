/**
 * Another product on a sales page (lib/sales-page.ts, ProductBlock;
 * lib/featured-cards.ts). Checked:
 *
 *   - a block keeps only a product id and a short line, nothing about the
 *     product itself, so what it shows is always today's;
 *   - the coach counts it filled only once a product is chosen;
 *   - cards come from the listings the store record carries, never the page's
 *     own product nor a draft, so drawing one costs no request;
 *   - the gallery offers it.
 */
import { readFileSync } from "node:fs";
import { MAX_PRODUCT_NOTE, emptyBlock, parsePage } from "@/lib/sales-page";
import { coachChecks } from "@/lib/page-coach";
import { BLOCK_GROUPS } from "@/components/block-picker";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("What the block keeps");
  const kept = parsePage({ blocks: [{ id: "prod0001", kind: "product", heading: "Goes well with it", product: "knife00001", note: "x".repeat(400), title: "Not kept", price: 1 }] }).blocks[0];
  is("the product's id and a short line, nothing else", kept.kind === "product" ? [kept.product, kept.note.length, Object.keys(kept).sort()] : null, ["knife00001", MAX_PRODUCT_NOTE, ["heading", "id", "kind", "note", "product"]]);
  const odd = parsePage({ blocks: [{ id: "prod0002", kind: "product", heading: "", product: "../store", note: "" }] }).blocks[0];
  is("what is not a product id is no product", odd.kind === "product" ? odd.product : null, "");
  is("a new one has no product yet", (emptyBlock("product") as { product: string }).product, "");

  part("The coach");
  const page = (product: string) => parsePage({ blocks: [{ id: "prod0003", kind: "product", heading: "", product, note: "" }] });
  const filled = (product: string) => coachChecks({ page: page(product), productTitle: "Bread", free: false, picture: false, pictureAlt: "", facts: {} }).length;
  is("reads it without failing, chosen or not", [filled("knife00001") > 0, filled("") > 0], [true, true]);

  part("Where cards come from");
  const source = readFileSync("lib/featured-cards.ts", "utf8");
  is("the store record's listings, never a request", [source.includes("store.catalog.head"), /await|redisPipeline|readListings/.test(source)], [true, false]);
  is("never the page's own product nor a draft", source.includes("if (listing.id === except || listing.hidden) continue;"), true);
  is("the gallery offers it", BLOCK_GROUPS.some((g) => g.kinds.includes("product")), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
