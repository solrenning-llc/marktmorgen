import type { NextRequest } from "next/server";
import { setAnswers } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { clearMissed } from "@/lib/answers";

/**
 * The answers to visitors' questions (lib/answers-rules.ts), from the studio:
 * `{ on, facts }` switches them on or off and keeps the creator's notes;
 * `{ clear: true }` forgets the questions kept for the creator once read.
 * What a store's pages say to buyers is the "page" permission.
 */
export async function POST(request: NextRequest) {
  // Emptying the list of missed questions cannot be undone: named apart (lib/two-step.ts).
  const guarded = await guardStoreWrite(request, "page", 6_000, (sent) => (sent.clear === true ? "clear" : ""));
  if (!guarded.ok) return guarded.response;
  try {
    if (guarded.body.clear === true) {
      await clearMissed(guarded.store);
      return Response.json({ ok: true });
    }
    const store = await setAnswers(guarded.ref, { on: guarded.body.on === true, facts: guarded.body.facts });
    if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });
    return Response.json({ ok: true, on: store.answers.on });
  } catch (error) {
    console.error("saving the answers setting failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
