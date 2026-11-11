/**
 * Checking that what a product delivers still works, the reading (479 [SB2],
 * unit 2; lib/delivery-check.ts; added 10 November 2026). Synthetic only:
 * every reader here is a fake, nothing reaches storage or the internet.
 * Checked:
 *
 *   - each thing a product hands over is read once and judged by unit 1's
 *     rules (lib/delivery-check-rules.ts): a file by its size in storage, an
 *     address by what it answered;
 *   - a reader that fails, throws or does not answer in time is "not
 *     checked", never "fine" and never "broken";
 *   - storage that is not set up is never read as a file gone;
 *   - at most MAX_DELIVERY_ITEMS things are read at a time, the rest are
 *     counted, never read and never said to be fine;
 *   - the route takes its studio requests before anything is read, after
 *     the product is known to be the store's, and those requests pay for the
 *     whole check at its worst (the owner's margin rule: the ceiling before
 *     the spend, an unknown cost never zero).
 */
import { readFileSync } from "node:fs";
import { BlobNotFoundError } from "@vercel/blob";
import { SafeFetchError } from "@/lib/safe-fetch";
import {
  ADDRESS_READ_BYTES,
  ADDRESS_REDIRECTS,
  ADDRESS_TIMEOUT_MS,
  DELIVERY_CHECK_UNITS,
  DELIVERY_ITEM_MS,
  MAX_DELIVERY_ITEMS,
  addressVerdict,
  fileVerdict,
  leftWords,
} from "@/lib/delivery-check-rules";
import { type DeliveryReaders, addressReader, checkDelivery, fileReader } from "@/lib/delivery-check";
import { R2_CLASS_B_MICRO_USD_PER_MILLION, VERCEL_CALL_MICRO_USD_PER_MILLION, VERCEL_CPU_MICRO_USD_PER_HOUR, VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR } from "@/lib/spend-cost-table";
import { MAX_PRODUCT_BYTES } from "@/lib/catalog";
import { COMMAND, DB_BYTE, ORIGIN_PER_BYTE, TAKE_COMMANDS, UNIT_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const vaultFile = (name: string) => `vault/${FOLDER}/p1/0123456789abcdef-${name}`;
const file = { pathname: vaultFile("guide.pdf"), bytes: 1200, name: "guide.pdf", contentType: "application/pdf", addedAt: "2026-11-10T00:00:00.000Z" };
const NOW = Date.UTC(2026, 10, 10, 12);

/** Readers that answer from a table and remember what they were asked. */
function fake(files: Record<string, Awaited<ReturnType<DeliveryReaders["file"]>> | Error>, addresses: Record<string, Awaited<ReturnType<DeliveryReaders["address"]>> | Error>) {
  const asked: string[] = [];
  const readers: DeliveryReaders = {
    file: async (pathname) => {
      asked.push(`file ${pathname}`);
      const answer = files[pathname];
      if (answer instanceof Error) throw answer;
      return answer === undefined ? null : answer;
    },
    address: async (url) => {
      asked.push(`address ${url}`);
      const answer = addresses[url];
      if (answer instanceof Error) throw answer;
      return answer ?? { problem: "network" };
    },
  };
  return { readers, asked };
}

async function main() {
  part("Each thing is read once and judged by unit 1's rules");
  {
    const { readers, asked } = fake({ [file.pathname]: { size: 1200 } }, { "https://example.com/bonus": { status: 200 } });
    const result = await checkDelivery(
      { file, link: null, options: [{ label: "Bonus", file: null, link: "https://example.com/bonus" }] },
      readers,
      NOW,
    );
    is("the product's file and the option's link, each read once", asked, [`file ${file.pathname}`, "address https://example.com/bonus"]);
    is("each judged as unit 1 says", result, {
      items: [
        { what: "Your file", verdict: fileVerdict("Your file", 1200, { size: 1200 }) },
        { what: 'The "Bonus" option\'s link', verdict: addressVerdict('The "Bonus" option\'s link', "https://example.com/bonus", { status: 200 }) },
      ],
      left: 0,
    });
    is("both fine", result.items.map((item) => item.verdict.state), ["ok", "ok"]);
  }
  {
    const { readers } = fake({ [file.pathname]: "missing" }, {});
    const result = await checkDelivery({ file, link: null }, readers, NOW);
    is("a file gone from storage is a problem, with what to do", [result.items[0].verdict.state, Boolean(result.items[0].verdict.fix)], ["problem", true]);
  }
  {
    const { readers } = fake({ [file.pathname]: { size: 99 } }, {});
    const result = await checkDelivery({ file, link: null }, readers, NOW);
    is("a file of another size is a problem", result.items[0].verdict.state, "problem");
  }
  {
    const { readers } = fake({}, { "https://example.com/gone": { status: 404 } });
    const result = await checkDelivery({ file: null, link: "https://example.com/gone" }, readers, NOW);
    is("an address that says it is gone is a problem", result.items[0].verdict.state, "problem");
  }
  {
    const { readers } = fake({}, { "https://example.com/room": { status: 200 } });
    const result = await checkDelivery({ file: null, link: null, call: { room: "https://example.com/room" } }, readers, NOW);
    is("a call's own meeting link is read as an address", result.items.map((item) => [item.what, item.verdict.state]), [["Your meeting link", "ok"]]);
  }
  {
    const { readers, asked } = fake({}, {});
    const result = await checkDelivery({ file: null, link: null, course: { id: "c1" } }, readers, NOW);
    is("nothing to check: nothing read, nothing said", [asked, result], [[], { items: [], left: 0 }]);
  }

  part("A reader that fails or does not answer is not checked, never fine and never broken");
  {
    const { readers } = fake({ [file.pathname]: new Error("storage down") }, {});
    const result = await checkDelivery({ file, link: null }, readers, NOW);
    is("a file reader that throws", result.items[0].verdict, fileVerdict("Your file", 1200, null));
    is("is not checked", result.items[0].verdict.state, "not-checked");
  }
  {
    const { readers } = fake({}, { "https://example.com/x": new Error("boom") });
    const result = await checkDelivery({ file: null, link: "https://example.com/x" }, readers, NOW);
    is("an address reader that throws is not checked", result.items[0].verdict.state, "not-checked");
  }
  {
    const never: DeliveryReaders = { file: () => new Promise(() => {}), address: () => new Promise(() => {}) };
    const started = Date.now();
    const result = await checkDelivery({ file, link: null, options: [{ label: "Two", file: null, link: "https://example.com/two" }] }, never, NOW, 30);
    is("readers that never answer are both not checked once their time is up", result.items.map((item) => item.verdict.state), ["not-checked", "not-checked"]);
    is("and the check ends instead of waiting on them", Date.now() - started < 5_000, true);
    is("an address with no answer in time says it did not answer", result.items[1].verdict, addressVerdict('The "Two" option\'s link', "https://example.com/two", { problem: "timeout" }));
  }
  is("each thing is given at most DELIVERY_ITEM_MS, longer than any reader's own wait", DELIVERY_ITEM_MS >= ADDRESS_TIMEOUT_MS && DELIVERY_ITEM_MS <= 25_000, true);

  part("At most MAX_DELIVERY_ITEMS at a time; the rest counted, never read, never fine");
  {
    const options = Array.from({ length: MAX_DELIVERY_ITEMS + 4 }, (_, i) => ({ label: `O${i}`, file: null, link: `https://example.com/o${i}` }));
    const addresses = Object.fromEntries(options.map((option) => [option.link, { status: 200 }]));
    const { readers, asked } = fake({}, addresses);
    const result = await checkDelivery({ file: null, link: "https://example.com/main", options }, readers, NOW);
    is("exactly MAX_DELIVERY_ITEMS read", asked.length, MAX_DELIVERY_ITEMS);
    is("the first ones, in the product's order", asked[0], "address https://example.com/main");
    is("the rest counted as left", result.left, options.length + 1 - MAX_DELIVERY_ITEMS);
    is("and only the read ones have a verdict", result.items.length, MAX_DELIVERY_ITEMS);
    is("the rest are said as not checked, with how many", leftWords(result.left), `${result.left} more things this product hands over were not checked this time: we check ${MAX_DELIVERY_ITEMS} at a time.`);
    is("one left, in the singular", leftWords(1), `1 more thing this product hands over was not checked this time: we check ${MAX_DELIVERY_ITEMS} at a time.`);
    is("none left: nothing said", [leftWords(0), leftWords(-1), leftWords(Number.NaN)], ["", "", ""]);
  }

  part("Storage: a file gone, a file there, storage not reached, storage not set up");
  {
    const asked: string[] = [];
    const read = fileReader({
      vaultReady: () => true,
      vault: async (pathname) => {
        asked.push(pathname);
        return pathname.endsWith("gone.pdf") ? null : pathname.endsWith("down.pdf") ? "unreachable" : { bytes: 1200, contentType: "application/pdf" };
      },
      blob: async () => {
        throw new Error("the host's store is not asked about a vault file");
      },
    });
    is("a vault file there", await read(vaultFile("guide.pdf")), { size: 1200 });
    is("a vault file confirmed gone", await read(vaultFile("gone.pdf")), "missing");
    is("a vault that did not answer: not known", await read(vaultFile("down.pdf")), null);
    is("each asked of the vault", asked.length, 3);
  }
  {
    let asked = 0;
    const read = fileReader({
      vaultReady: () => false,
      vault: async () => {
        asked += 1;
        return null;
      },
      blob: async () => ({ size: 1 }),
    });
    is("a vault not set up is never read as the file gone", [await read(vaultFile("guide.pdf")), asked], [null, 0]);
  }
  {
    const read = fileReader({
      vaultReady: () => true,
      vault: async () => null,
      blob: async (pathname) => {
        if (pathname.endsWith("gone.pdf")) throw new BlobNotFoundError();
        if (pathname.endsWith("down.pdf")) throw new Error("timed out");
        return { size: 640 };
      },
    });
    is("a file in the host's store, there", await read("store/abc/guide.pdf"), { size: 640 });
    is("one the host's store says is not there", await read("store/abc/gone.pdf"), "missing");
    is("one the host's store could not be asked about: not known", await read("store/abc/down.pdf"), null);
  }
  {
    const read = fileReader({ vaultReady: () => true, vault: async () => null, blob: async () => ({ size: "640" as unknown as number }) });
    is("a size that is not a whole number is not known, never a size", await read("store/abc/odd.pdf"), null);
  }

  part("Addresses: read through lib/safe-fetch.ts, with its ceilings");
  {
    const calls: unknown[] = [];
    const read = addressReader(async (url, options) => {
      calls.push([url, options]);
      if (url.endsWith("/private")) throw new SafeFetchError("private", "private network");
      if (url.endsWith("/boom")) throw new Error("socket hang up");
      return { status: 302, headers: {}, body: Buffer.alloc(0), url };
    });
    is("an answer is its status", await read("https://example.com/ok"), { status: 302 });
    is("a refusal is its reason", await read("https://example.com/private"), { problem: "private" });
    is("any other failure did not answer, never fine", await read("https://example.com/boom"), { problem: "network" });
    is("a GET, read at most ADDRESS_READ_BYTES, within ADDRESS_TIMEOUT_MS, following ADDRESS_REDIRECTS", calls[0], [
      "https://example.com/ok",
      { method: "GET", maxBytes: ADDRESS_READ_BYTES, timeoutMs: ADDRESS_TIMEOUT_MS, maxRedirects: ADDRESS_REDIRECTS },
    ]);
  }

  part("The route: the product known first, the studio requests taken before anything is read");
  {
    const route = readFileSync("app/api/store/delivery-check/route.ts", "utf8");
    const known = route.indexOf("hasProduct(store, id)");
    const paid = route.indexOf("countStudio(store, null, DELIVERY_CHECK_UNITS)");
    const listing = route.indexOf("readListingExactly(store, id)");
    const checked = route.indexOf("checkDelivery(");
    is("a product the store does not have is refused before anything is taken", known > 0 && known < paid, true);
    is("the studio requests are taken before the product is read and checked", paid > 0 && paid < listing && listing < checked, true);
    is("only who may change products may check them", route.includes('guardStoreWrite(request, "products"'), true);
    is("a product read in an unknown shape is said as such, nothing checked", route.includes('listing === "unknown"'), true);
    is("the route may run past the slowest thing it waits on", /export const maxDuration = (\d+);/.exec(route)?.[1] !== undefined && Number(/export const maxDuration = (\d+);/.exec(route)![1]) * 1000 > DELIVERY_ITEM_MS + 5_000, true);
    const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
    is("the registry cites the check among the studio's requests", registry.includes('{ file: "app/api/store/delivery-check/route.ts", names: ["countStudio(store, null, DELIVERY_CHECK_UNITS)"] }'), true);
  }

  part("Those requests pay for the whole check at its worst");
  {
    const micro = (n: number) => n / 1_000_000;
    const CALL = micro(VERCEL_CALL_MICRO_USD_PER_MILLION) / 1_000_000;
    const CPU_SECOND = micro(VERCEL_CPU_MICRO_USD_PER_HOUR) / 3600;
    const MEMORY_SECOND = (micro(VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR) * VERCEL_FUNCTION_GB) / 3600;
    // A look at a kept file: Vercel Blob's head is a "Simple Operation", $0.40 a million on demand (vercel.com/docs/
    // vercel-blob/usage-and-pricing, read 2 November 2026, 479 [SB2]); the vault's HEAD is an R2 Class B operation at
    // $0.36 a million, and it asks twice when the size is not stated (lib/vault.ts, headVault). The dearer, twice.
    const STORAGE_LOOK = 2 * Math.max(0.4 / 1_000_000, micro(R2_CLASS_B_MICRO_USD_PER_MILLION) / 1_000_000);
    // An address's request out and its answer read, headers included, at the origin's rate (a review ceiling: the
    // answer comes in, which the host does not bill as sent, priced all the same so an unknown is never zero).
    const ADDRESS_BYTES = ADDRESS_READ_BYTES + 32_768 + 4_096;
    const perItem = STORAGE_LOOK + ADDRESS_BYTES * ORIGIN_PER_BYTE + 0.05 * CPU_SECOND;
    // The function held at 2 GB for the longest wait of all, the product's record read, its few commands.
    const check = CALL + 0.5 * CPU_SECOND + (DELIVERY_ITEM_MS / 1000 + 2) * MEMORY_SECOND + (2 + TAKE_COMMANDS) * COMMAND + MAX_PRODUCT_BYTES * DB_BYTE
      + MAX_DELIVERY_ITEMS * perItem + 64_000 * ORIGIN_PER_BYTE;
    is(`DELIVERY_CHECK_UNITS (${DELIVERY_CHECK_UNITS}) studio requests pay for a check at its worst ($${check.toFixed(7)})`, DELIVERY_CHECK_UNITS * UNIT_COST.studio >= check, true);
    is("a whole number of requests, at least one", Number.isSafeInteger(DELIVERY_CHECK_UNITS) && DELIVERY_CHECK_UNITS >= 1, true);
  }

  done();
}

void main();
