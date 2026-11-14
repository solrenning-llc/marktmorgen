/**
 * A product description in a file (CSV or another platform's export) is brought in whole or refused with a reason,
 * never cut short. readBatch keeps a cell to its cap plus one (MAX_ABOUT_LENGTH * 2 + 1 for a description) so a cell
 * too long can be told; classifyProducts checked the length of the text left from that cut HTML, so a description
 * whose markup passed the raw cap was cut where the cap fell, often inside a tag, and the dry run said "Made as a
 * paid draft" for it, as the import then made it (docs/cross-product-handoff.md: never silently truncate). Synthetic.
 */
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { previewImport, readBatch } from "@/lib/imports";
import { MAX_ABOUT_LENGTH } from "@/lib/product-about";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const owner = "import-description@example.com";
  await claimHandle(owner, "importdescription", "Import Description", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const store = (await storeForEmail(owner))!;
  const styled = (words: string) => `<p style="margin:0 0 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#333">${words}</p>`;
  const paragraph = styled("Lesson notes. ".repeat(5));
  const outcomeOf = async (description: string): Promise<[string, string] | string> => {
    const rows = readBatch("products", [[2, "Guide", "19", description, "", ""]]);
    if (!rows) return "unread";
    const preview = await previewImport(store, "products", { expected: 1, file: "products.csv", source: "csv" }, rows);
    if (!preview.ok) return preview.reason;
    const row = preview.rows.find((r) => r[0] === 2)!;
    return [row[1], row[2]];
  };

  part("A styled description is brought in whole or refused, never cut");
  const short = paragraph.repeat(20);
  is("setup: a styled description under the raw cap with little text", [short.length < MAX_ABOUT_LENGTH * 2, short.length], [true, short.length]);
  is("control: it is made as a draft", await outcomeOf(short), ["added", "title"]);
  const shortText = paragraph.repeat(60) + styled("THE END");
  is("setup: its text is under the limit, its markup over the raw cap", [shortText.replace(/<[^>]*>/g, "").length < MAX_ABOUT_LENGTH, shortText.length > MAX_ABOUT_LENGTH * 2], [true, true]);
  is("a description whose markup is over what is read is refused on its description, not cut before THE END", await outcomeOf(shortText), ["error", "description"]);
  const longText = paragraph.repeat(80) + styled("THE END");
  is("setup: its text alone is over the limit", longText.replace(/<[^>]*>/g, "").length > MAX_ABOUT_LENGTH, true);
  is("a description whose text is over the limit is refused, not cut under it (as it was once its markup took the cut)", await outcomeOf(longText), ["error", "description"]);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
