/**
 * A buyer's stamped copies go when the buyer is deleted (audit R12, item 1).
 *
 * A stamped PDF or EPUB (lib/pdf-stamp.ts) carries "Sold to <address>" on every page, and is kept in the private
 * file store beside the original, with a record pointing at it for 400 days. Before this, deleting the buyer
 * (lib/person-erasure.ts) never reached either: the copy stayed for as long as the creator kept the original, and
 * lib/person-data.ts did not say so, because tests/person-data-scan.ts did not look inside files written to the file
 * store.
 *
 * Here: a buyer's copy and its record are gone after their erasure, another buyer's stay; a deletion the file store
 * fails is handed to the erasure's own last try and the daily job, and the erasure says it is not finished; a list of notes read in any other shape
 * deletes nothing and is never answered as done (CX-123 rule 24); and a copy whose note for the erasure cannot be
 * confirmed is never kept, the original being handed over instead.
 *
 * Vercel Blob is stood in for in memory (tests/stamped-drop-retry-world.ts); Redis is the repository's in-memory
 * stand-in (tests/redis-stub.ts); every store, file and address is synthetic.
 */
import { PDFDocument } from "pdf-lib";
import * as stamp from "@/lib/pdf-stamp";
import { erasePerson } from "@/lib/person-erasure";
import { sweepTaskUploads } from "@/lib/assignment";
import { deleteFile } from "@/lib/file-store";
import type { ProductFile } from "@/lib/product-file";
import * as world from "./stamped-drop-retry-world";
import { makeWorld } from "./erasure-world";
import { store as redis } from "./redis-stub";
// A new stamped copy reserves its bytes in the store's storage (lib/storage-reservations.ts; audit R17, finding 1).
import "./storage-reservation-scripts";
import { done, is, part } from "./check";

const FOLDER = "fedcba9876543210fedcba9876543210";
/** The daily job's list of files to delete (lib/assignment.ts), which an erasure hands what it could not delete. */
const DOORS = "nl:tasks:doors";
const PAID = Date.UTC(2026, 10, 9) / 1000;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return json({ id: "email_1" });
  if (url.hostname.endsWith("stripe.com")) return json({ object: "list", data: [], has_more: false });
  return realFetch(input as string, init);
}) as typeof fetch;

let n = 0;
async function original(name = "Guide.pdf"): Promise<ProductFile> {
  n += 1;
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  const bytes = await doc.save();
  const pathname = `stores/${FOLDER}/${String(n).padStart(10, "0")}/${name}`;
  world.files.set(pathname, bytes);
  return { pathname, name, bytes: bytes.byteLength, contentType: "application/pdf", addedAt: `2026-11-09T12:00:0${n % 10}.000Z` };
}
const sale = (reference: string, email: string) => ({ reference, email, paidAt: PAID });
const record = async (key: string) => (await redis.pipeline([["GET", key]]))[0];
const copiesUnder = (file: ProductFile) => [...world.files.keys()].filter((pathname) => pathname.startsWith(stamp.copyFolder(file))).sort();
/** Runs with every reply to one Redis command answered in a shape of the test's choosing. */
async function bending<T>(command: string, answer: unknown, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((one, i) => (String(one[0]).toUpperCase() === command ? answer : replies[i]));
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}
const stampedPart = (result: Awaited<ReturnType<typeof erasePerson>>) => ("parts" in result ? result.parts.find((p) => p.module === "lib/pdf-stamp.ts")?.records ?? null : null);
const failedPart = (result: Awaited<ReturnType<typeof erasePerson>>) => ("failed" in result ? result.failed.includes("lib/pdf-stamp.ts") : false);

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_stamped_erasure_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_stamped_erasure_only_a_stand_in";
  const quiet = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  const w = await makeWorld("stamp-erase-shop", "stamp-keeper@example.com");
  const shop = w.store;

  part("A buyer's stamped copy goes with the buyer; another buyer's stays");
  const guide = await original();
  const ana = await stamp.stampedCopy(guide, sale("cs_test_ana000000001", "Ana@Example.com"), shop);
  const sam = await stamp.stampedCopy(guide, sale("cs_test_sam000000001", "sam@example.com"), shop);
  is("control: each buyer gets a copy of their own, with its record", [Boolean(ana), Boolean(sam), ana?.pathname !== sam?.pathname, typeof (await record(stamp.copyKey("cs_test_ana000000001", guide)))], [true, true, true, "string"]);
  const erased = await erasePerson(shop, "ana@example.com", { kind: "person" });
  is("the erasure answers done", erased.ok, true);
  is("the buyer's copy is gone from the file store", world.files.has(ana?.pathname ?? ""), false);
  is("and the record pointing at it", await record(stamp.copyKey("cs_test_ana000000001", guide)), null);
  is("the result names the stamped copies, one deleted", stampedPart(erased), 1);
  is("control: the other buyer's copy and record stay", [world.files.has(sam?.pathname ?? ""), typeof (await record(stamp.copyKey("cs_test_sam000000001", guide)))], [true, "string"]);
  is("control: the original stays", world.files.has(guide.pathname), true);
  is("control: deleting the same buyer again deletes nothing more and is done", stampedPart(await erasePerson(shop, "ana@example.com", { kind: "person" })), 0);

  part("A deletion the file store fails is never answered done, and the copy still goes");
  const bob = await stamp.stampedCopy(guide, sale("cs_test_bob000000001", "bob@example.com"), shop);
  world.failDeletes(1);
  const failing = await erasePerson(shop, "bob@example.com", { kind: "person" });
  is("the erasure says it is not finished, naming the stamped copies", [failing.ok, failedPart(failing)], [false, true]);
  is("the copy was handed to the erasure's own try at the end, which deleted it", world.files.has(bob?.pathname ?? ""), false);
  const cara = await stamp.stampedCopy(guide, sale("cs_test_cara00000001", "cara@example.com"), shop);
  world.failDeletes(2);
  const down = await erasePerson(shop, "cara@example.com", { kind: "person" });
  is("with the file store down for both tries, the erasure is still not answered done", [down.ok, failedPart(down)], [false, true]);
  is("the copy is still there, and on the daily job's list of files to delete", [world.files.has(cara?.pathname ?? ""), ((await redis.pipeline([["ZRANGEBYSCORE", DOORS, "-inf", "+inf"]]))[0] as string[]).includes(cara?.pathname ?? "")], [true, true]);
  is("the daily job deletes it, and nothing else", [await sweepTaskUploads((paths) => deleteFile(paths), Date.now() + 2 * 86_400_000), world.files.has(cara?.pathname ?? ""), world.files.has(sam?.pathname ?? "")], [[cara?.pathname], false, true]);

  part("Notes read in any other shape delete nothing and are never answered done (rule 24)");
  const dan = await stamp.stampedCopy(guide, sale("cs_test_dan000000001", "dan@example.com"), shop);
  const before = world.deleted.length;
  const bent = await bending("ZRANGEBYSCORE", "OK", () => erasePerson(shop, "dan@example.com", { kind: "person" }));
  is("the erasure says the stamped copies are not finished", [bent.ok, failedPart(bent)], [false, true]);
  is("and nothing was deleted on that read: the copy and its record stay", [world.deleted.length, world.files.has(dan?.pathname ?? ""), typeof (await record(stamp.copyKey("cs_test_dan000000001", guide)))], [before, true, "string"]);
  const exact = await erasePerson(shop, "dan@example.com", { kind: "person" });
  is("an exact read then deletes the copy and its record", [exact.ok, world.files.has(dan?.pathname ?? ""), await record(stamp.copyKey("cs_test_dan000000001", guide))], [true, false, null]);

  part("A copy whose note for the erasure cannot be confirmed is never kept");
  const ledger = await original("Ledger.pdf");
  const unnoted = await bending("ZADD", "OK", () => stamp.stampedCopy(ledger, sale("cs_test_eve000000001", "eve@example.com"), shop));
  is("the original is handed over instead", unnoted, null);
  is("and no copy is left in the file store", copiesUnder(ledger), []);
  const noStats = await stamp.stampedCopy(ledger, sale("cs_test_eve000000002", "eve@example.com"), { ...shop, statsId: null });
  is("a store with nothing to note a buyer by keeps no copy either", [noStats, copiesUnder(ledger)], [null, []]);
  const noted = await stamp.stampedCopy(ledger, sale("cs_test_eve000000003", "eve@example.com"), shop);
  is("control: with the note confirmed, the copy is made", [Boolean(noted), copiesUnder(ledger).length], [true, 1]);

  console.error = quiet;
}

main().then(done, (error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
