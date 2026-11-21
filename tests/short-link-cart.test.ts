/**
 * 624 [SZ8](23), unit 3: a short link for one post that opens a ready cart.
 * Checked on the rules, the store of links and the real /l/<code> redirect:
 *
 *   - a cart target holds two to MAX_CART of the store's products, each once,
 *     and a code only of the shape a link code has, in capitals;
 *   - the link opens the store with those products in the cart (restore) and
 *     the code remembered for checkout, tagged with the post like any link;
 *   - the studio's list says where it goes and keeps it when nothing changes;
 *     the builder offers it with a labeled name and place.
 */
import { readFileSync } from "node:fs";
import { MAX_CART } from "@/lib/cart-rules";
import { landingUrl, readTarget } from "@/lib/short-link-rules";
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { GET } from "@/app/l/[code]/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const isProduct = (id: string) => ["bread", "pastry", "pie", "tart", "cake"].includes(id);

  part("A cart as where a link goes");
  is("two of the store's products, and a code in capitals", readTarget({ kind: "cart", ids: ["bread", "pastry"], code: " spring " }, isProduct), { kind: "cart", ids: ["bread", "pastry"], code: "SPRING" });
  is("no code is fine", readTarget({ kind: "cart", ids: ["bread", "pastry"] }, isProduct), { kind: "cart", ids: ["bread", "pastry"] });
  is("refused: one product, the same twice, too many, another store's, or a code of the wrong shape", [
    readTarget({ kind: "cart", ids: ["bread"] }, isProduct),
    readTarget({ kind: "cart", ids: ["bread", "bread"] }, isProduct),
    readTarget({ kind: "cart", ids: ["bread", "pastry", "pie", "tart", "cake"].slice(0, MAX_CART + 1) }, isProduct),
    readTarget({ kind: "cart", ids: ["bread", "theirs"] }, isProduct),
    readTarget({ kind: "cart", ids: ["bread", "pastry"], code: "no spaces!" }, isProduct),
  ], [null, null, null, null, null]);
  is("it opens the store with the cart and the code, tagged with the post", landingUrl("https://marktmorgen.com/@harbor", { name: "october-reel", place: "instagram", target: { kind: "cart", ids: ["bread", "pastry"], code: "SPRING" } }),
    "https://marktmorgen.com/@harbor?utm_source=instagram&utm_medium=post&utm_campaign=october-reel&restore=bread%2Cpastry&code=SPRING");

  part("Through the real redirect");
  await claimHandle("cartlink@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("cartlink@example.com");
  const store = (await storeForEmail("cartlink@example.com"))!;
  const made = await addLink({ sid: store.sid, statsId: store.statsId! }, { name: "Bake Sale", place: "email", target: { kind: "cart", ids: ["bread", "pastry"], code: "SPRING" } }, isProduct, 1000);
  if (!made.ok) throw new Error(`no link: ${made.reason}`);
  const answer = await GET(new Request(`https://marktmorgen.com/l/${made.link.code}`) as never, { params: Promise.resolve({ code: made.link.code }) });
  const to = new URL(answer.headers.get("location") ?? "https://x.invalid");
  is("sent to the store with the cart and the code", [answer.status, to.pathname, to.searchParams.get("restore"), to.searchParams.get("code"), to.searchParams.get("utm_campaign")], [302, "/@harbor", "bread,pastry", "SPRING", "bake-sale"]);

  part("The studio");
  const list = readFileSync("components/short-links.tsx", "utf8");
  is("the list says where it goes and keeps it as its own choice", list.includes("a ready cart of ${t.ids.length} products") && list.includes('link.target.kind === "cart" ? <option value={targetValue(link.target)}>'), true);
  const builder = readFileSync("components/cart-link-builder.tsx", "utf8");
  is("the builder offers a short link with a labeled name and place", builder.includes('htmlFor="cart-link-post"') && builder.includes('htmlFor="cart-link-place"') && builder.includes('{ kind: "cart", ids: ask.ids, code: ask.code }') && builder.includes("ids: [...picked], code: code.trim().toUpperCase()"), true);
  is("and says the result in a status, or why not in an alert", builder.includes('role="status"') && builder.includes('role="alert"'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
