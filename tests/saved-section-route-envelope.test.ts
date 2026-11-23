/**
 * #5010 row 126: the store's fence on a saved section's write (SAVE_STORE_SECTION) adds the erasing field and the live
 * key to the script, so the whole studio request that saves a section is measured here through the real route, POST
 * /api/store/saved-blocks, against the envelope of one studio unit: 20 commands, TAKE_COMMANDS and
 * LOCKED_UNTIL_STAR_COMMANDS (coordinator 964c, the same envelope as the other fenced studio writes). Every command is
 * billed as Upstash bills it: a plain command is one, and a script is one plus every redis.call written in it (a bound
 * on its worst branch). A new section and an edit of one used by no page are both measured; the request must stay
 * inside the envelope, or this line needs its own price in the registry.
 *
 * Synthetic store and the in-memory Redis; nothing real is called.
 */
import { NextRequest } from "next/server";
import { emptyBlock, type PageBlock } from "@/lib/sales-page";
import { claimHandle, ensureStatsId, ensureStoreId } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST } from "@/app/api/store/saved-blocks/route";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const ENVELOPE = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
const billed = (command: (string | number)[]): number =>
  command[0] === "EVAL" ? 1 + (String(command[1]).match(/redis\.call\(/g) ?? []).length : 1;
const faq = (q: string): PageBlock => ({ ...(emptyBlock("faq") as Extract<PageBlock, { kind: "faq" }>), items: [{ q, a: "An answer." }] });

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "section-envelope@example.test";
  await claimHandle(OWNER, "sectionenvelope", "Section Envelope", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const real = redis.pipeline.bind(redis);
  const measured = async (body: Record<string, unknown>) => {
    let commands = 0;
    let fenced = 0;
    redis.pipeline = (async (batch: Commands) => {
      for (const command of batch) {
        commands += billed(command);
        if (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:saved-store-section:")) fenced += 1;
      }
      return real(batch);
    }) as typeof redis.pipeline;
    try {
      const response = await POST(new NextRequest("https://marktmorgen.com/api/store/saved-blocks", { method: "POST", headers, body: JSON.stringify(body) }));
      return { status: response.status, data: (await response.json().catch(() => ({}))) as Record<string, unknown>, commands, fenced };
    } finally {
      redis.pipeline = real;
    }
  };

  part("A new section: the whole request");
  const added = await measured({ action: "save", name: "Buyer questions", blocks: [faq("Is it for me?")] });
  is("saved", [added.status, added.data.ok], [200, true]);
  is("through the fenced write", added.fenced, 1);
  is(`its ${added.commands} billed commands stay within one studio unit's ${ENVELOPE}`, added.commands > 0 && added.commands <= ENVELOPE, true);

  part("An edit of that section, used by no page: the whole request");
  const id = String((added.data.section as { id?: unknown } | undefined)?.id ?? "");
  const edited = await measured({ action: "update", id, name: "Buyer questions (edited)", blocks: [faq("Is it for me?"), faq("How long?")] });
  is("saved", [edited.status, edited.data.ok], [200, true]);
  is("through the fenced write", edited.fenced, 1);
  is(`its ${edited.commands} billed commands stay within one studio unit's ${ENVELOPE}`, edited.commands > 0 && edited.commands <= ENVELOPE, true);
  console.log(`MEASURED save=${added.commands} update=${edited.commands} envelope=${ENVELOPE}`);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
