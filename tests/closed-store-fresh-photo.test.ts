/**
 * A photo put on a closing store's page while its erasure runs is erased with
 * it, never left behind (Codex G's MEDIUM on #3614, review 6782212736; Claude
 * 3's focal comment 6785333946).
 *
 * lib/closed-store-data.ts eraseClosed reads the store record, prepareStore
 * makes many round trips (its team, its hosts' claims, its keys for the API,
 * its webhooks...) and then closeStoreRecord deletes the record, all from
 * that first read. A photo the creator put on in between (the photo route:
 * writePhoto, then setPhotoId under the store's lock) was named only by the
 * record that went: its id was not among the walk's marks, so
 * nl:store:photo:<id> stayed for ever, with nothing naming it and no expiry.
 *
 * Now the record is read again under the store's lock right before it goes,
 * every id it names then is a mark of the walk's entry before the record is
 * deleted (only while that lock is still the erasure's), and a read again
 * that does not read is never "nothing new" (rule 24): the record stays and
 * the store waits a walk. Synthetic stores and photos, in-memory Redis.
 */
import { BATCH_KEY, DUE_KEY, WALK_GAP_MS, eraseClosed, markDue } from "@/lib/closed-store-data";
import { claimHandle, ensureStatsId, ensureStoreId, setPhotoId, storeForEmail, type Store } from "@/lib/store";
import { deletePhoto, writePhoto } from "@/lib/store-photo";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// What happens while the erasure is between its first read and the record going: run when the walk's entry is
// written (HSET BATCH_KEY), the last step before closeStoreRecord, as a request in that window would.
let inWindow: (() => Promise<void>) | null = null;
// The record's read right before it goes answers what Redis never says for a GET (armed by the window).
let rereadUnknown = false;
let ownerOf = "";
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = async (commands: (string | number)[][]) => {
  if (inWindow && commands.some((c) => c[0] === "HSET" && c[1] === BATCH_KEY)) {
    const run = inWindow;
    inWindow = null;
    await run();
  }
  if (rereadUnknown && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === ownerOf) {
    rereadUnknown = false;
    return ["QUEUED"];
  }
  return realPipeline(commands);
};

/** The photo route's order (app/api/store/photo/route.ts): the new picture written, the store pointed at it, the old one deleted. */
async function putPhoto(email: string): Promise<string> {
  const id = await writePhoto(PNG, "image/png");
  const result = await setPhotoId(email, id);
  if (!result.ok) {
    await deletePhoto(id);
    throw new Error("setup: the store is gone");
  }
  await deletePhoto(result.was);
  return id;
}

async function makeStore(email: string, handle: string): Promise<Store> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = await storeForEmail(email);
  if (!store) throw new Error(`setup: ${handle}`);
  return store;
}

const photoKeys = () => redis.keys().filter((key) => key.startsWith("nl:store:photo:"));
/** Keys still named by one of these ids: the store's own, and every photo it ever had. */
const leftNamedBy = (ids: string[]) => redis.keys().filter((key) => ids.some((id) => key.includes(id)));

async function erase(now: number) {
  return eraseClosed(Date.now() + 30_000, async () => {}, now);
}

async function main(): Promise<void> {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

  part("Control: a photo the store had when its erasure started is erased with it");
  redis.clear();
  {
    const email = "control@example.com";
    const store = await makeStore(email, "controlphoto");
    const shown = await putPhoto(email);
    await markDue(email, Date.now() - 1000);
    const report = await erase(Date.now());
    is("the store is prepared and its walk finishes", [report.stores, report.finished], [1, 1]);
    is("no store photo is left", photoKeys(), []);
    is("nothing named by its ids is left", leftNamedBy([store.sid, store.statsId ?? "-", shown]), []);
  }

  part("A photo replaced while the erasure runs: the new one is erased too, never orphaned (Codex G's probe)");
  redis.clear();
  {
    const email = "replaced@example.com";
    const store = await makeStore(email, "replacedphoto");
    const first = await putPhoto(email);
    let second = "";
    inWindow = async () => {
      second = await putPhoto(email);
    };
    await markDue(email, Date.now() - 1000);
    const report = await erase(Date.now());
    is("the replacement landed in the window, after the first read", second.length === 32 && second !== first, true);
    is("the store is prepared and its walk finishes", [report.stores, report.finished], [1, 1]);
    is("the record is gone", await storeForEmail(email), null);
    is("no store photo is left (no orphan)", photoKeys(), []);
    is("nothing named by its ids or either photo is left", leftNamedBy([store.sid, store.statsId ?? "-", first, second]), []);
  }

  part("A first photo put on while the erasure runs is erased too");
  redis.clear();
  {
    const email = "first@example.com";
    const store = await makeStore(email, "firstphoto");
    let put = "";
    inWindow = async () => {
      put = await putPhoto(email);
    };
    await markDue(email, Date.now() - 1000);
    const report = await erase(Date.now());
    is("the photo landed in the window", put.length, 32);
    is("the store is prepared and its walk finishes", [report.stores, report.finished], [1, 1]);
    is("no store photo is left (no orphan)", photoKeys(), []);
    is("nothing named by its ids or the photo is left", leftNamedBy([store.sid, store.statsId ?? "-", put]), []);
  }

  part("Rule 24: a read again of the record that does not read keeps it, and the store waits a walk");
  redis.clear();
  {
    const email = "unknown@example.com";
    const store = await makeStore(email, "unknownphoto");
    let put = "";
    ownerOf = String(redis.keys().find((key) => key.startsWith("nl:store:owner:") && redis.run(["GET", key]) !== null && String(redis.run(["GET", key])).includes(email)));
    inWindow = async () => {
      put = await putPhoto(email);
      rereadUnknown = true;
    };
    const T = Date.now();
    await markDue(email, T - 1000);
    await erase(T);
    const score = redis.run(["ZSCORE", DUE_KEY, email]);
    is("the record is not deleted on a read that did not read", (await storeForEmail(email))?.photoId ?? null, put);
    is("the store is still in line, moved back a walk", score !== null && Number(score) >= T + WALK_GAP_MS, true);
    const next = await erase(T + WALK_GAP_MS + 1);
    is("the next walk prepares it and finishes", [next.stores, next.finished], [1, 1]);
    is("the record is gone then", await storeForEmail(email), null);
    is("and no store photo is left", photoKeys(), []);
    is("nothing named by its ids or the photo is left", leftNamedBy([store.sid, store.statsId ?? "-", put]), []);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
