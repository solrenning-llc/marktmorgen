/**
 * The gallery blocks are added from (components/block-picker.tsx): every kind
 * of block a page can have is in it, once, so none can only be added some
 * other way, and the editor no longer reads a long drop-down.
 */
import { readFileSync } from "node:fs";
import { BLOCK_GROUPS } from "@/components/block-picker";
import { BLOCK_KINDS } from "@/lib/sales-page";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("Every block, once");
  const listed = BLOCK_GROUPS.flatMap((g) => g.kinds);
  is("each kind is in the gallery", BLOCK_KINDS.map((k) => k.kind).filter((k) => !listed.includes(k)), []);
  is("and only once", listed.length, new Set(listed).size);
  is("nothing that is not a block", listed.filter((k) => !BLOCK_KINDS.some((b) => b.kind === k)), []);

  part("The editor uses it");
  const editor = readFileSync("components/page-editor.tsx", "utf8");
  is("the drop-down is gone", editor.includes('id="add-kind"'), false);
  is("a block can be added between two others", editor.includes("placeAt(index + 1)") && editor.includes("onPick={(kind) => add(kind, at, true)}"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
