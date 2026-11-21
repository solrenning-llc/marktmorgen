/**
 * Codex X3/X6 MEDIUM on #3474 (758 [STN5]): the route checks once, before the
 * model runs, that the product is a draft that hands over nothing yet
 * (fileTargetProblem). The PDF is drawn and written long after. If another
 * session publishes the product or gives it a link meanwhile, the save must
 * not attach the PDF (which would publish nothing but clear that link): the
 * same check runs again inside the locked change that attaches the file
 * (attachDraftFile), and a product that changed answers "changed" with its
 * delivery untouched. Putting a displaced file back is a restore: it is never
 * refused by that check. The route attaches through attachDraftFile only.
 * Synthetic: the in-memory database.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setProductHidden, setProductLink, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { attachDraftFile } from "@/lib/ai-file";
import type { ProductFile } from "@/lib/product-file";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "file.attach@example.com";
const file = (name: string): ProductFile => ({ pathname: `vault/${"a".repeat(32)}/p/${"b".repeat(16)}-${name}`, name, bytes: 10, contentType: "application/pdf", addedAt: "2026-11-21T00:00:00.000Z" });

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  redis.clear();
  await claimHandle(OWNER, "fileattach", "File Attach", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Recipe Guide", "Weeknight dinners", "27", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  await setProductHidden(OWNER, id, true);
  const store = async () => (await storeForEmail(OWNER))!;

  part("A draft that still hands over nothing takes the file");
  const kept = await attachDraftFile(OWNER, id, file("Guide.pdf"));
  is("attached", [kept.ok, kept.ok ? kept.removed : "x"], [true, null]);
  is("the product's file is the new PDF, still a draft", [(await readListing(await store(), id))?.file?.name, (await readListing(await store(), id))?.hidden], ["Guide.pdf", true]);

  part("A link added by another session after the first check: refused, the link kept");
  const other = await addProduct(OWNER, "Recipe Pack", "Forty dinners", "27", null);
  if (!other.ok) throw new Error("no product");
  await setProductHidden(OWNER, other.product.id, true);
  const linked = await setProductLink(OWNER, other.product.id, "https://example.com/pack");
  if (!linked.ok) throw new Error("no link");
  const raced = await attachDraftFile(OWNER, other.product.id, file("Pack.pdf"));
  is("changed", raced, { ok: false, reason: "changed" });
  const after = await readListing(await store(), other.product.id);
  is("the link is still what it delivers, and no file", [after?.link, after?.file ?? null], ["https://example.com/pack", null]);

  part("Published by another session after the first check: refused, nothing attached");
  const shown = await addProduct(OWNER, "Recipe Book", "Sixty dinners", "27", null);
  if (!shown.ok) throw new Error("no product");
  await setProductHidden(OWNER, shown.product.id, false);
  is("changed", await attachDraftFile(OWNER, shown.product.id, file("Book.pdf")), { ok: false, reason: "changed" });
  is("no file on the published product", (await readListing(await store(), shown.product.id))?.file ?? null, null);

  part("A file arrived meanwhile: refused too, the file that arrived kept");
  const filled = await addProduct(OWNER, "Recipe Notes", "Notes", "27", null);
  if (!filled.ok) throw new Error("no product");
  await setProductHidden(OWNER, filled.product.id, true);
  const first = await attachDraftFile(OWNER, filled.product.id, file("Mine.pdf"));
  if (!first.ok) throw new Error("no first file");
  is("changed", await attachDraftFile(OWNER, filled.product.id, file("Late.pdf")), { ok: false, reason: "changed" });
  is("the file that arrived first is kept", (await readListing(await store(), filled.product.id))?.file?.name, "Mine.pdf");

  part("Putting a displaced file back is a restore, never refused by the draft check");
  const back = await attachDraftFile(OWNER, filled.product.id, file("Back.pdf"), { restore: true });
  is("put back", [back.ok, back.ok ? back.removed?.name : null], [true, "Mine.pdf"]);

  part("The route attaches only through attachDraftFile");
  const route = readFileSync("app/api/store/ai-file/route.ts", "utf8");
  is("attachDraftFile in the route", /\battachDraftFile\(/.test(route), true);
  is("never the bare setProductFile", /\bsetProductFile\(/.test(route), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
