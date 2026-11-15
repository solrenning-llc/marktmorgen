/**
 * 568 [GD2] (i), unit 2: the store's "at least 18" yes goes with the store's own data.
 *
 * Unit 1 (tests/gd2i-adult-confirmation.test.ts) keeps the owner's yes on the store record: the version of the
 * sentence checked and the time. What the store keeps about its owner is theirs to take, so:
 *
 *   - the store's data export file (lib/store-export.ts) carries it in its "store" part, exactly as kept (the
 *     version and the ISO time), and a store made before the box existed carries no such field, never a made-up
 *     yes;
 *   - the list of what is kept about accounts (lib/person-data.ts, an "account" line of lib/store.ts) says so,
 *     the privacy policy says it is in the export, and every place that lists the file's contents and says
 *     "Nothing else is in it" names it (the studio twice, the feature pages twice, the closing email). The Terms'
 *     own list of the file is left for the Terms unit of (i), which needs an official dated source.
 *
 * Synthetic store and in-memory database only; Stripe answers 404, so no sale is read.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { ADULT_VERSION } from "@/lib/adult-confirmation";
import { storeExport } from "@/lib/store-export";
import { PERSON_DATA } from "@/lib/person-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** The "store" object of an export file: the first part, before the products. */
function storePart(file: string): Record<string, unknown> | null {
  const at = file.indexOf('"store":');
  if (at < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = at + 8; i < file.length; i += 1) {
    const c = file[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return JSON.parse(file.slice(at + 8, i + 1)) as Record<string, unknown>;
  }
  return null;
}

async function main(): Promise<void> {
  redis.clear();
  const AT = "2026-11-15T19:30:00.000Z";

  part("The export carries the yes as kept");
  const owner = "adult.export@example.com";
  await claimHandle(owner, "adultexport", "Adult Export", "Prints.", { version: ADULT_VERSION, at: AT });
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  const store = (await storeForEmail(owner))!;
  is("the store keeps it", store.adultConfirmed, { version: 1, at: AT });
  const kept = storePart(await text(storeExport(store)));
  is("the file's store part holds it, exactly", kept?.adultConfirmed, { version: 1, at: AT });
  is("and still the store's own fields", [kept?.handle, kept?.name], ["adultexport", "Adult Export"]);

  part("A store made before the box carries none");
  const older = "adult.older@example.com";
  await claimHandle(older, "adultolder", "Adult Older", "");
  await ensureStatsId(older);
  await ensureStoreId(older);
  const before = storePart(await text(storeExport((await storeForEmail(older))!)));
  is("its store part is read", before?.handle, "adultolder");
  is("with no yes in it", before ? Object.hasOwn(before, "adultConfirmed") : true, false);

  part("Said where what is kept is listed");
  const line = PERSON_DATA.find((entry) => entry.file === "lib/store.ts" && entry.how === "account" && /at least 18/.test(entry.what));
  is("an account line of lib/store.ts names the yes, its version and time, and the export", [!!line, /version/.test(line?.what ?? ""), /time/.test(line?.what ?? ""), /export/i.test(line?.what ?? "")], [true, true, true, true]);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the privacy policy says the yes is in the store's export file", /version of that sentence you saw and when[^.]*\. It is in the file you can download with your store&apos;s data\./.test(privacy), true);

  is("the privacy policy's date is the day it first said so", /<LegalPage title="Privacy Policy" lastUpdated="November 15, 2026">/.test(readFileSync("app/privacy/page.tsx", "utf8")), true);
  const AGE = "the age box you checked when you made it (if any)";
  const count = (file: string) => readFileSync(file, "utf8").replace(/",\s*"\s*/g, " ").replace(/\s+/g, " ").split(AGE).length - 1;
  is("the studio, the feature pages and the closing email list it among the file's contents", [count("app/studio/page.tsx"), count("lib/feature-pages.ts"), count("lib/plan-closing.ts")], [2, 2, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
