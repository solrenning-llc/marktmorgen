import type { Store } from "@/lib/store";
import { storeFolder, storeRef } from "@/lib/store";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { addCaption, dropCaption, type CaptionAnswer } from "@/lib/stream";
import { readStreamPath } from "@/lib/stream-rules";
import { withOwnCaptions } from "@/lib/auto-captions";

/** A change by hand to captions, or why not: AI captions hold the language (lib/auto-captions.ts, withOwnCaptions). */
export type StoreCaptionAnswer = CaptionAnswer | { ok: false; reason: "auto_writing" | "auto_held" };

/** Its outcome is known: the service answered, or nothing was asked of it. Only "unavailable" may hide a landed change. */
const known = (answer: CaptionAnswer) => answer.ok || answer.reason !== "unavailable";

/** Runs a change by hand only while no AI captions request holds its language. */
async function byHand(pathname: string, lang: string, change: () => Promise<CaptionAnswer>): Promise<StoreCaptionAnswer> {
  const held = await withOwnCaptions(pathname, lang, change, known);
  return held.ok ? held.result : { ok: false, reason: held.reason };
}

/** New manual caption work, bound to the owner of the video's folder, never in a language AI captions hold. */
export async function addStoreCaption(store: Store, pathname: string, lang: string, file: unknown): Promise<StoreCaptionAnswer> {
  const path = readStreamPath(pathname);
  if (!path || path.folder !== await storeFolder(storeRef(store))) return { ok: false, reason: "unknown" };
  if (store.period?.funded === true && !await reservePaidResourceWindow(store)) return { ok: false, reason: "unavailable" };
  return byHand(pathname, lang, () => addCaption(pathname, lang, file));
}

/** Takes a video's captions in one language away by hand, never in a language AI captions hold. */
export async function dropStoreCaption(pathname: string, lang: string): Promise<StoreCaptionAnswer> {
  return byHand(pathname, lang, () => dropCaption(pathname, lang));
}
