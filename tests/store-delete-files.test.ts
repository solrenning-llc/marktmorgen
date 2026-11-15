/**
 * An extra store deleted from the studio (app/api/store/stores, lib/store.ts deleteStore) takes its files with it:
 * the pictures in its picture folder (images/<imageFolder>/: its links', its pages', its emails' pictures) and
 * whatever is left in its own folder (stores/<storeFolder>/: an upload never attached). Before, they stayed in the
 * file store for good: the store's record is gone, so no page, job or closing (lib/plan-closing.ts removeStored reads
 * the record first) ever finds them again, and they were kept, and paid for, for ever. A delete that fails goes to
 * the daily job that deletes uploads nobody keeps (sweepTaskUploads), never lost. Synthetic only.
 */
import { NextRequest } from "next/server";
import { POST as storesRoute } from "@/app/api/store/stores/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { sweepTaskUploads } from "@/lib/assignment";
import { deleteFile } from "@/lib/file-store";
import { claimHandle, createStore, ensureStatsId, imageFolder, storeFolder, storeRef } from "@/lib/store";
import { files, state } from "./store-delete-files-world";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

async function deleteFromStudio(owner: string, handle: string, sid: string) {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const form = new FormData();
  form.set("action", "delete");
  form.set("confirm", handle);
  return storesRoute(new NextRequest("https://marktmorgen.com/api/store/stores", { method: "POST", headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie, "x-nimbus-store": sid }, body: form }));
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("An empty extra store with pictures on its links and pages");
  const owner = "files-owner@example.com";
  await claimHandle(owner, "filesfirst", "Files first", "");
  await ensureStatsId(owner);
  const made = await createStore(owner, "filesextra", "Files extra", "");
  if (!made.ok) throw new Error("no extra store");
  const ref = storeRef(made.store);
  const picture = `images/${await imageFolder(ref)}/link-picture.webp`;
  const leftover = `stores/${await storeFolder(ref)}/never-attached.zip`;
  const homePicture = `images/${await imageFolder(owner)}/home-picture.webp`;
  files.set(picture, 40_000);
  files.set(leftover, 900_000);
  files.set(homePicture, 40_000);
  const response = await deleteFromStudio(owner, "filesextra", made.store.sid);
  is("the store is deleted", [response.status, response.headers.get("Location")?.includes("stores=deleted")], [303, true]);
  is("its pictures and its leftover file are deleted with it", [files.has(picture), files.has(leftover)], [false, false]);
  is("the account's first store keeps its own", files.has(homePicture), true);

  part("A file store that does not answer at the delete");
  const second = await createStore(owner, "filesother", "Files other", "");
  if (!second.ok) throw new Error("no second extra store");
  const otherPicture = `images/${await imageFolder(storeRef(second.store))}/page-picture.webp`;
  files.set(otherPicture, 40_000);
  state.failing = true;
  const failed = await deleteFromStudio(owner, "filesother", second.store.sid);
  state.failing = false;
  is("the store is still deleted", [failed.status, failed.headers.get("Location")?.includes("stores=deleted")], [303, true]);
  const swept = await sweepTaskUploads(deleteFile, Date.now() + 2 * 86_400_000);
  is("its picture goes with the daily job", [swept.includes(otherPicture), files.has(otherPicture)], [true, false]);
  done();
}

void main();
