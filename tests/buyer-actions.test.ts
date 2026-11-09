/**
 * What buyers do inside what they bought, counted in the store's month
 * (lib/buyer-actions.ts, added 18 October 2026), and the files that come
 * with it: the pictures a community keeps (lib/community-files.ts,
 * lib/community-picture-rules.ts) and the room students' work has
 * (lib/assignment-rules.ts). tests/plan-cost-registry.ts prices each.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { deleted, files, setFailDeletes } from "./buyer-actions-blob";
import { PICTURE_REQUEST_UNITS, restingAway, takeBuyerAction, takeBuyerRead } from "@/lib/buyer-actions";
import { allowanceUsed } from "@/lib/store-allowance";
import { NON_PAYING_ALLOWANCES, STORE_ALLOWANCES, allowanceFor } from "@/lib/store-allowance-rules";
import { requestsIn } from "@/lib/traffic";
import { allowanceWindow } from "@/lib/allowance-window";
import { communityFolder } from "@/lib/community-image";
import { dropCommunityImage, noteCommunityUpload, picturesKept, sweepCommunityUploads, takeCommunityUpload, takePicturePlace } from "@/lib/community-files";
import { COMMUNITY_PICTURES, TRIAL_COMMUNITY_PICTURES, picturesLimitFor } from "@/lib/community-picture-rules";
import { MAX_STORE_TASK_BYTES, TASK_ROOM_BYTES, TRIAL_TASK_ROOM_BYTES, taskRoomFor } from "@/lib/assignment-rules";
import { hasRoom, takeRoom } from "@/lib/assignment";
import { claimHandle, ensureStatsId, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const plan = { subscriptionActive: true, subscriptionId: "sub_Buyer0000001", trialEnds: 0, planEndedAt: "" };

beforeEach(() => {
  redis.clear();
  files.clear();
  deleted.length = 0;
  setFailDeletes(false);
});

async function payingStore(handle: string, tier: "creator" | "pro" | "scale" = "creator"): Promise<Store> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, handle, "");
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier, period: paidPeriod() });
  return (await storeForEmail(email))!;
}

test("a buyer's action is one of the store's buyer actions, refused past the month's figure", async () => {
  const store = await payingStore("actions");
  const limit = STORE_ALLOWANCES.creator.buyer;
  let taken = 0;
  while (await takeBuyerAction(store)) taken += 1;
  assert.equal(taken, limit);
  assert.equal(await allowanceUsed(store, "buyer"), limit);
  // The creator's own acts there are studio requests, not their buyers'.
  assert.equal(await takeBuyerAction(store, "owner"), true);
  assert.equal(await allowanceUsed(store, "studio"), 1);
  // A larger plan has more in the same month.
  assert.equal(await takeBuyerAction({ ...store, tier: "pro" }), true);
});

test("marked funded buyer and owner actions require their resource month before allowance use", async () => {
  const made = await payingStore("fundedactions");
  await ensureStatsId(made.email);
  const store = (await storeForEmail(made.email))!;
  const funded = { ...store, period: { ...store.period!, funded: true as const } };
  assert.equal(await takeBuyerAction(funded), false);
  assert.equal(await takeBuyerAction(funded, "owner"), false);
  assert.equal(await allowanceUsed(store, "buyer"), 0);
  assert.equal(await allowanceUsed(store, "studio"), 0);
});

test("a store that pays nothing has few, a store whose plan ended answers its buyers a little", () => {
  assert.equal(allowanceFor({ ...plan, subscriptionActive: false, subscriptionId: null }, "buyer"), NON_PAYING_ALLOWANCES.none.buyer);
  assert.equal(allowanceFor({ ...plan, subscriptionActive: false }, "buyer"), NON_PAYING_ALLOWANCES.ended.buyer);
  assert.equal(allowanceFor({ ...plan, trialEnds: Date.now() / 1000 + 86_400 }, "webhook"), NON_PAYING_ALLOWANCES.trial.webhook);
  for (const tier of ["creator", "pro", "scale"] as const) assert.ok(STORE_ALLOWANCES[tier].buyer > 0 && STORE_ALLOWANCES[tier].webhook > 0, tier);
});

test("a read on the buyers' side is one of the store's public requests, a picture several", async () => {
  const store = await payingStore("reads");
  const folder = await storeFolder("reads@example.com");
  const window = allowanceWindow(store)!.id;
  assert.equal(await takeBuyerRead(store), true);
  assert.equal(await takeBuyerRead(store, PICTURE_REQUEST_UNITS), true);
  assert.equal(await requestsIn(folder, window), 1 + PICTURE_REQUEST_UNITS);
  // A paying store whose month is not known answers nothing that costs.
  assert.equal(await takeBuyerRead({ ...store, period: null }), false);
});

test("a form the store cannot take goes to the page that says it rests", () => {
  const away = restingAway("https://marktmorgen.com", { handle: "shop" });
  assert.deepEqual([away.status, away.headers.get("Location")], [303, "https://marktmorgen.com/@shop/resting"]);
});

test("each picture door takes one of the community's places; deleting gives it back, and an unused door is swept a day on", async () => {
  const folder = communityFolder("c".repeat(32));
  const path = (n: number) => `community/${folder}/${String(n).padStart(16, "0")}.jpg`;
  assert.equal(await takePicturePlace(path(1), 2), true);
  assert.equal(await takePicturePlace(path(2), 2), true);
  assert.equal(await takePicturePlace(path(3), 2), false, "past the number, no door");
  assert.equal(await picturesKept(folder), 2);
  files.add(path(1));
  await dropCommunityImage(path(1));
  assert.deepEqual([await picturesKept(folder), files.has(path(1))], [1, false]);
  // A door given and used is not swept; one never used is, a day on.
  const now = Date.now();
  await noteCommunityUpload(path(2), "member-a", now - 2 * 86_400_000);
  await noteCommunityUpload(path(4), "member-b", now - 2 * 86_400_000);
  await takePicturePlace(path(4), 5);
  assert.equal(await takeCommunityUpload(path(2), "member-a"), true);
  assert.equal(await sweepCommunityUploads(now), 1);
  assert.deepEqual([deleted.includes(path(4)), deleted.includes(path(2)), await picturesKept(folder)], [true, false, 1]);
  // A sweep that cannot delete gives nothing back, and tries again later.
  await noteCommunityUpload(path(5), "member-c", now - 2 * 86_400_000);
  await takePicturePlace(path(5), 5);
  setFailDeletes(true);
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await sweepCommunityUploads(now), 0);
  } finally {
    console.error = quiet;
  }
  assert.equal(await picturesKept(folder), 2);
  setFailDeletes(false);
  assert.equal(await sweepCommunityUploads(now), 1);
  assert.equal(await picturesKept(folder), 1);
});

test("how many pictures a community keeps, and how much students' work, by plan", () => {
  for (const tier of ["creator", "pro", "scale"] as const) {
    assert.equal(picturesLimitFor({ ...plan, tier }), COMMUNITY_PICTURES[tier]);
    assert.equal(taskRoomFor({ ...plan, tier }), TASK_ROOM_BYTES[tier]);
  }
  const trial = { ...plan, trialEnds: Date.now() / 1000 + 86_400 };
  const ended = { ...plan, subscriptionActive: false };
  assert.deepEqual([picturesLimitFor(trial), taskRoomFor(trial)], [TRIAL_COMMUNITY_PICTURES, TRIAL_TASK_ROOM_BYTES]);
  assert.deepEqual([picturesLimitFor(ended), taskRoomFor(ended)], [0, 0]);
  assert.equal(MAX_STORE_TASK_BYTES, Math.max(...Object.values(TASK_ROOM_BYTES)));
});

test("students' work is held to its plan's room", async () => {
  const room = TASK_ROOM_BYTES.creator;
  assert.equal(await hasRoom("store-1", room, room), true);
  assert.equal(await takeRoom("store-1", room - 10, room), true);
  assert.equal(await takeRoom("store-1", 11, room), false);
  assert.equal(await hasRoom("store-1", 10, room), true);
  assert.equal(await hasRoom("store-1", 11, room), false);
  assert.equal(await takeRoom("store-1", 5, 0), false, "a store with no room takes nothing");
});

test("every route a buyer acts through takes from the store's month before it writes", () => {
  const routes: [string, RegExp][] = [
    ["app/api/store/community/route.ts", /takeBuyerAction\(store, owner \? "owner" : "buyer"\)/],
    ["app/api/store/community/rsvp/route.ts", /takeBuyerAction\(store\)/],
    ["app/api/store/community/challenge/route.ts", /takeBuyerAction\(store\)/],
    ["app/api/store/community/chat/route.ts", /takeBuyerAction\(store, owner \? "owner" : "buyer"\)/],
    ["app/api/store/community/messages/route.ts", /takeBuyerAction\(store, owner \? "owner" : "buyer"\)/],
    ["app/api/store/community/push/route.ts", /takeBuyerAction\(store, viewer\.owner \? "owner" : "buyer"\)/],
    ["app/api/store/community/upload/route.ts", /takePicturePlace\(pathname, picturesLimitFor\(store\)\)/],
    ["app/api/store/community/image/route.ts", /takeBuyerRead\(store, PICTURE_REQUEST_UNITS\)/],
    ["app/api/store/community/calendar/route.ts", /takeBuyerRead\(store\)/],
    ["app/api/store/community/open/route.ts", /takeBuyerRead\(store\)/],
    ["app/api/store/community/link/route.ts", /takeBuyerRead\(store\)/],
    ["app/api/store/course/comment/route.ts", /takeBuyerAction\(store, owner \? "owner" : "buyer"\)/],
    ["app/api/store/course/task/route.ts", /takeBuyerAction\(store\)/],
    ["app/api/store/course/task/upload/route.ts", /takeBuyerAction\(on\.store\)/],
    ["app/api/store/course/progress/route.ts", /takeBuyerAction\(store, access\.learner\.owner \? "owner" : "buyer"\)/],
    ["app/api/store/course/certificate/route.ts", /takeBuyerAction\(store\)/],
    ["app/api/store/course/file/route.ts", /takePublicRequest\(store, found\.lesson\.preview \? "public" : "buyer"\)/],
    ["app/api/store/course/open/route.ts", /takeBuyerRead\(store\)/],
    ["app/api/store/course/link/route.ts", /takeBuyerRead\(store\)/],
    ["app/api/store/letters/open/route.ts", /takeBuyerRead\(store\)/],
    ["app/api/store/letters/link/route.ts", /takeBuyerRead\(store\)/],
    ["app/api/store/podcast/open/route.ts", /takeBuyerRead\(store\)/],
    ["app/api/store/podcast/play/[token]/[episode]/route.ts", /takeBuyerRead\(store\)/],
  ];
  for (const [file, pattern] of routes) assert.match(read(file), pattern, file);
});
