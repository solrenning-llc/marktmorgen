/**
 * What a limited product's stock record weighs, and what every public page
 * that shows it reads (Claude 3's performance audit, 13 November 2026).
 *
 * lib/stock.ts keeps one field per checkout that holds or bought a unit, and
 * a sold unit's field is never let go (confirmStock, the settling in
 * countStock). stockLeft reads the whole record (HGETALL) on the store page,
 * a collection, a product's page, the embedded card and the cart, so both
 * the record and each reading grow with every sale, up to MAX_STOCK
 * (100,000) fields. The data room counts the records beside a product at
 * PRODUCT_SIDE_BYTES (lib/store-data-rules.ts), stock included, and a page
 * read is priced by its commands: a record past that room is a cost the
 * model does not hold (custo desconhecido reprova).
 *
 * Checked with Redis stubbed, nothing real: a product with 1,000 units, each
 * sold through confirmStock with a checkout id in Stripe's live shape.
 */
import { parseProduct } from "@/lib/catalog";
import { confirmStock, stockLeft } from "@/lib/stock";
import { PRODUCT_SIDE_BYTES } from "@/lib/store-data-rules";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const creator = { statsId: "h".repeat(32), stripeAccountId: "acct_1TestHashBytes" } as Store;
const UNITS = 1_000;
const product = parseProduct({ id: "hash1", title: "Print run", summary: "", priceCents: 2000, stock: UNITS, link: "https://example.com/hash1" }) as Listing;
const key = `nl:stock:${creator.statsId}:${product.id}`;
/** A live checkout id as Stripe writes it: cs_live_ and 58 more characters. */
const session = (i: number) => `cs_live_a1${String(i).padStart(56, "0")}`;

async function storedBytes(): Promise<number> {
  const [raw] = (await redis.pipeline([["HGETALL", key]])) as unknown[];
  const flat = Array.isArray(raw) ? (raw as string[]) : [];
  return key.length + flat.reduce((sum, part) => sum + String(part).length, 0);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("A sold-out run of a limited product");
  for (let i = 0; i < UNITS; i += 1) await confirmStock(creator, product, session(i));
  is("every unit is sold", await stockLeft(creator, product), 0);
  const bytes = await storedBytes();
  is("its stock record stays inside the room counted beside a product", bytes <= PRODUCT_SIDE_BYTES, true);

  part("Control: a run of a few units");
  redis.clear();
  for (let i = 0; i < 5; i += 1) await confirmStock(creator, product, session(i));
  is("five sold leave the rest", await stockLeft(creator, product), UNITS - 5);
  is("and weigh little", (await storedBytes()) <= PRODUCT_SIDE_BYTES, true);

  console.log(`  (measured: ${bytes} bytes for ${UNITS} sold units, ${Math.round(bytes / UNITS)} a unit; room ${PRODUCT_SIDE_BYTES})`);
  done();
}

void main();
