/**
 * The store photo is never kept where nothing can find it (r24 review, unit
 * store-photo, MEDIUM): a photo written for the page and not put on, because
 * pointing the store at it failed, and an old photo whose deletion failed after
 * the store stopped showing it, are named in the store's own record until
 * their deletion is confirmed. So each one is deleted by the next upload, is
 * erased with the store when it closes (its id is one of the store's marks,
 * lib/closed-store-data.ts) and is weighed with the store's data. A Redis
 * answer in an unknown shape is never taken as "written" or "deleted"
 * (rule 24). Synthetic Redis only.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { marksOf } from "@/lib/closed-store-data";
import { POST as photoRoute } from "@/app/api/store/photo/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "photo.maker@example.com";
const ORIGIN = "https://marktmorgen.com";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
const PHOTO = "nl:store:photo:";

const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);
/** Lets one pipeline throw, or answer in another shape, when `when` says so. */
let fault: ((commands: Commands) => "throw" | "odd" | null) | null = null;
redis.pipeline = (async (commands: Commands) => {
  const hit = fault ? fault(commands) : null;
  if (hit === "throw") throw new Error("synthetic Redis timeout");
  const replies = await original(commands);
  return hit === "odd" ? replies.map(() => "QUEUED") : replies;
}) as typeof redis.pipeline;

const photoKeys = () => redis.keys().filter((key) => key.startsWith(PHOTO));
const touches = (commands: Commands, op: string, prefix: string) =>
  commands.some((c) => String(c[0]).toUpperCase() === op && String(c[1] ?? "").startsWith(prefix));

async function named(): Promise<Set<string>> {
  const store = await storeForEmail(OWNER);
  if (!store) throw new Error("no store");
  const text = JSON.stringify(store);
  return new Set(photoKeys().map((key) => key.slice(PHOTO.length)).filter((id) => text.includes(id)));
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "photoshop", "Photo Shop", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const send = async (body: unknown): Promise<[number, string]> => {
    const response = await photoRoute(
      new NextRequest(`${ORIGIN}/api/store/photo`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify(body),
      }),
    );
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    return [response.status, data.error ?? ""];
  };
  const upload = () => send({ photo: `data:image/png;base64,${PNG}` });
  const shown = async () => (await storeForEmail(OWNER))?.photoId ?? null;
  const unnamed = async () => {
    const ids = await named();
    return photoKeys().filter((key) => !ids.has(key.slice(PHOTO.length)));
  };

  part("Healthy control: a photo put on, then replaced");
  is("the first photo is put on", await upload(), [200, ""]);
  const first = await shown();
  is("the store shows it, and it is the one photo kept", photoKeys(), [`${PHOTO}${first}`]);
  is("a new photo over it is put on", await upload(), [200, ""]);
  const second = await shown();
  is("the old one is deleted, the new one is the one kept", photoKeys(), [`${PHOTO}${second}`]);

  part("Pointing the store at the new photo fails after the photo was written");
  let written = false;
  fault = (commands) => {
    if (touches(commands, "SET", PHOTO)) written = true;
    else if (written && touches(commands, "GET", "nl:store:owner:")) {
      fault = null;
      return "throw";
    }
    return null;
  };
  is("the creator is told to try again", await upload(), [500, "server_error"]);
  is("the store still shows the photo it had", await shown(), second);
  is("no photo is kept that the store record does not name (the walk erases what it names)", await unnamed(), []);
  const left = (await named()).size;
  is("the photo written for nothing is named in the store record", left, 2);
  const store = await storeForEmail(OWNER);
  const marks = store ? (await marksOf(store)).marks : [];
  is("and is one of the marks the closing walk erases", photoKeys().every((key) => marks.includes(key.slice(PHOTO.length))), true);

  part("The retry after the waiting time deletes it");
  shift += 16 * 60_000;
  is("the retry is put on", await upload(), [200, ""]);
  const third = await shown();
  is("only the photo shown is kept", photoKeys(), [`${PHOTO}${third}`]);

  part("Deleting the old photo fails after the store points at the new one");
  fault = (commands) => {
    if (touches(commands, "DEL", `${PHOTO}${third}`)) {
      fault = null;
      return "throw";
    }
    return null;
  };
  // Not said as done while the old photo's deletion is unconfirmed (CX-123 rule 24), yet never left unnamed.
  is("the creator is told the replace is not done", await upload(), [500, "server_error"]);
  const fourth = await shown();
  is("the new photo is on the page", fourth !== third && fourth !== null, true);
  is("the old photo is still named in the store record, never left unnamed", await unnamed(), []);
  is("both are kept for now", photoKeys().length, 2);
  is("the next upload deletes it", await upload(), [200, ""]);
  is("only the photo shown is kept", photoKeys(), [`${PHOTO}${await shown()}`]);
  is("the fourth photo went with it", photoKeys().includes(`${PHOTO}${fourth}`), false);

  part("Taking the photo off when its deletion fails");
  fault = (commands) => {
    if (touches(commands, "DEL", PHOTO)) {
      fault = null;
      return "throw";
    }
    return null;
  };
  const onPage = await shown();
  // Deleted before the page stops showing it, so an unconfirmed deletion is answered as an error (CX-123 rule 24).
  is("the creator is told it was not taken off", await send({ remove: true }), [500, "server_error"]);
  is("the store still shows it, so the studio still offers to take it off", await shown(), onPage);
  is("the photo kept is named in the store record", await unnamed(), []);
  is("the next try takes it off", await send({ remove: true }), [200, ""]);
  is("the store shows none", await shown(), null);
  is("and no photo is kept", photoKeys(), []);
  is("nor named as left", (await storeForEmail(OWNER))?.photoLeft ?? [], []);
  is("a photo put on later is on", await upload(), [200, ""]);
  is("only the photo shown is kept", photoKeys(), [`${PHOTO}${await shown()}`]);

  part("Rule 24: a write or a deletion answered in an unknown shape is not done");
  fault = (commands) => (touches(commands, "SET", PHOTO) ? "odd" : null);
  is("an unknown answer to the photo's write is not a photo put on", await upload(), [500, "server_error"]);
  fault = null;
  is("and nothing is kept unnamed", await unnamed(), []);
  shift += 16 * 60_000;
  const before = await shown();
  fault = (commands) => (touches(commands, "DEL", PHOTO) ? "odd" : null);
  is("a deletion answered in an unknown shape is not said as done", await upload(), [500, "server_error"]);
  fault = null;
  is("nothing is kept unnamed", await unnamed(), []);
  // The DEL ran and its answer was lost: the record keeps naming the photo until a deletion is confirmed.
  is("the replaced photo is still named in the store record", ((await storeForEmail(OWNER))?.photoLeft ?? []).some((left) => left.id === before), true);
  is("the next upload deletes it", await upload(), [200, ""]);
  is("only the photo shown is kept", photoKeys(), [`${PHOTO}${await shown()}`]);

  part("A bounded number of photos waiting, never an unbounded pile");
  for (let i = 0; i < 2; i += 1) {
    let wrote = false;
    fault = (commands) => {
      if (touches(commands, "SET", PHOTO)) wrote = true;
      else if (wrote && touches(commands, "GET", "nl:store:owner:")) {
        fault = null;
        return "throw";
      }
      return null;
    };
    is(`failed upload ${i + 1} asks to try again`, await upload(), [500, "server_error"]);
  }
  fault = null;
  is("with two waiting, a third is asked to wait a few minutes", await upload(), [503, "photo_wait"]);
  is("nothing more was written for it", photoKeys().length, 3);
  shift += 16 * 60_000;
  is("after the wait the upload goes through", await upload(), [200, ""]);
  is("only the photo shown is kept", photoKeys(), [`${PHOTO}${await shown()}`]);
  is("the store record names no photo waiting", (await storeForEmail(OWNER))?.photoLeft ?? [], []);
  done();
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    Date.now = realNow;
  });
