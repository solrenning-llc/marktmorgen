import type { Store } from "@/lib/store";
import { storeFolder, storeRef } from "@/lib/store";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { addCaption, type CaptionAnswer } from "@/lib/stream";
import { readStreamPath } from "@/lib/stream-rules";
import { autoWriting } from "@/lib/auto-captions";

/** New manual caption work, bound to the owner of the video's folder. */
export async function addStoreCaption(store: Store, pathname: string, lang: string, file: unknown): Promise<CaptionAnswer> {
  const path = readStreamPath(pathname);
  if (!path || path.folder !== await storeFolder(storeRef(store))) return { ok: false, reason: "unknown" };
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return { ok: false, reason: "unavailable" };
  // A language AI captions were paid for and are still being written in: a file of the creator's own in it would be
  // counted as the service's delivery (no refund for what it never wrote), and the service may later replace it.
  if (((await autoWriting([pathname]))[pathname] ?? []).includes(lang)) return { ok: false, reason: "writing" };
  return addCaption(pathname, lang, file);
}
