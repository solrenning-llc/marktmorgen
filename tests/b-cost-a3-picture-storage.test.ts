/**
 * Rule MR audit, A3: a store's product, link and page pictures live under images/<imageFolder>/ (lib/store.ts,
 * imageFolder), a folder salted apart from its files' stores/<folder>/. filesHeld listed only the files' folder and
 * the vault, so pictures were never counted against the plan's storage figure, and a store at its figure could keep
 * adding files on top of them. storageUsed must count the picture folder too, and say "unavailable" when it cannot
 * be read; every measurement that admits an upload must pass it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { storageUsed } from "@/lib/storage-quota";
import { broken, held } from "./b-cost-a3-storage-world";
import { done, is, part } from "./check";

const files = "0123456789abcdef0123456789abcdef";
const pictures = "a".repeat(24);

async function main(): Promise<void> {
  part("A store's pictures count against its storage");
  held.set(`stores/${files}/guide.pdf`, 300);
  held.set(`images/${pictures}/${"b".repeat(32)}.webp`, 500);
  held.set(`images/${pictures}/${"c".repeat(32)}.jpg`, 200);
  held.set(`images/${"d".repeat(24)}/${"e".repeat(32)}.jpg`, 9_000);
  const measure = storageUsed as (folder: string, brake: number, pictureFolder: string) => ReturnType<typeof storageUsed>;
  const use = await measure(files, 1_000, pictures);
  is("files and the store's own pictures, nobody else's", [use.available, use.bytes], [true, 1_000]);
  is("so the store is at its figure", use.full, true);
  broken.add(`images/${pictures}/`);
  is("a picture folder that cannot be read is no measurement", (await measure(files, 10_000, pictures)).available, false);
  broken.clear();

  // The measurements that admit a new upload. A plan's closing (lib/plan-closing.ts, and the studio figure it shows)
  // never removes pictures, so counting them there is the erasure flow's own decision, outside this audit.
  part("Every measurement that admits an upload passes the store's picture folder");
  const sites = ["app/api/store/file/route.ts", "app/api/store/stream/route.ts", "app/api/store/vault/route.ts"];
  for (const site of sites) {
    const source = readFileSync(join(process.cwd(), site), "utf8");
    const calls = [...source.matchAll(/storageUsed\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map((m) => m[1]);
    is(`${site}: each storageUsed call has a third argument`, calls.length > 0 && calls.every((args) => args.replace(/\([^()]*\)/g, "()").split(",").length >= 3), true);
  }
  const vault = readFileSync(join(process.cwd(), "lib/vault-storage.ts"), "utf8");
  is("the vault's admission has no measurement of its own without the pictures", /storageUsed\(/.test(vault), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
