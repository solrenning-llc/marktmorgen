import type { NextRequest } from "next/server";
import { StoreFullError } from "@/lib/store-full";
import { setProductNote } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readNote } from "@/lib/thanks-note";
import { writeThanksNote } from "@/lib/thanks-note-store";
import { IMITATION_FIX, MAX_TEXT, brandImitationOnPage, excerptAt, imitationIn, imitationWhy } from "@/lib/brand-imitation-rules";
import type { ThanksNote } from "@/lib/thanks-note";

/**
 * The part of a note after paying that poses as Marktmorgen itself (568 [GD2] (c), lib/brand-imitation-rules.ts): its
 * heading, its text, its button's words or an address its button leads to that only looks like marktmorgen.com.
 * Shown the moment a card was just used, it is where a fake "confirm your card" works best. Null when none does.
 */
function noteImitation(note: ThanksNote): { field: "heading" | "body" | "button" | "link"; excerpt: string; why: string; fix: string } | null {
  const why = imitationWhy("the note cannot be shown with it");
  for (const [field, words] of [["heading", note.heading], ["body", note.body], ["button", note.button?.label ?? ""]] as const) {
    const text = words.slice(0, MAX_TEXT);
    const found = imitationIn(text);
    if (found) return { field, excerpt: excerptAt(text, found.at, found.length), why, fix: IMITATION_FIX };
  }
  const link = note.button ? brandImitationOnPage([], [note.button.url]) : null;
  return link ? { field: "link", excerpt: link.excerpt, why, fix: IMITATION_FIX } : null;
}

/**
 * A product's note after paying (lib/thanks-note.ts), from the studio:
 * `{ id, note: { heading, body, video, label, url } }`, or `{ id, note: null }`
 * to take it off. Part of the product, so the products permission.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 12_000);
  if (!guarded.ok) return guarded.response;
  const id = text(guarded.body.id, 40);
  const store = guarded.store;
  const product = id ? await readListing(store, id) : null;
  if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  if (!store.statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  const note = guarded.body.note === null ? null : readNote(guarded.body.note);
  if (typeof note === "string") return Response.json({ ok: false, error: note }, { status: 400 });
  const posing = note ? noteImitation(note) : null;
  if (posing) return Response.json({ ok: false, error: "brand_imitation", passage: posing }, { status: 409 });
  try {
    // Written before the product says it has one, and forgotten after it says it has none.
    if (note) await writeThanksNote(store.statsId, id, note, store);
    const marked = await setProductNote(guarded.ref, id, note !== null);
    if (!marked.ok) return Response.json({ ok: false, error: marked.reason }, { status: 400 });
    if (!note) await writeThanksNote(store.statsId, id, null, store);
    return Response.json({ ok: true, note });
  } catch (error) {
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("saving a note after paying failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
