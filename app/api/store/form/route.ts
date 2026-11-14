import { withinStore } from "@/lib/metered-limits";
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { originFrom, linkOrigin } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { readForm, addResponse } from "@/lib/form-store";
import { enroll } from "@/lib/flows";
import { FORM_ID, formOpen, outcomeOf, readAnswers, scoreOf, scoreQuery } from "@/lib/forms";
import { askToJoin } from "@/lib/store-join";
import { leadAffiliate, visitCookies } from "@/lib/affiliate-leads";
import { funnelMark } from "@/lib/page-funnel";
import { countFunnelDone, funnelHere, funnelVisitor } from "@/lib/page-funnel-store";
import { isStorePeople } from "@/lib/visit";

/** A form's answers, with room to spare: twelve questions, two of them long. */
const MAX_BODY_BYTES = 40_000;
/** Answers sent from one connection to one store in an hour. */
const PER_HOUR = 20;

/**
 * Takes a form's answers (lib/forms.ts): a plain HTML form on one of the
 * store's own pages, so it works with JavaScript off. The answers are read
 * against the form as it is now, kept for the creator, and, when the person
 * checked the box, the address is sent the button that puts it on the list
 * (lib/store-join.ts). Then the person goes on: to the next step of the
 * funnel the page is in, or to a page with their result or a thank-you.
 *
 * Nothing typed is ever put in an address this sends anybody to.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

  let form: FormData;
  try {
    form = await (await limited(request, MAX_BODY_BYTES)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const one = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const handle = normaliseHandle(one("handle"));
  const formId = one("form");
  const pageId = one("page").slice(0, 12);
  const mark = funnelMark(one("f"));
  if (!handle || !FORM_ID.test(formId)) return new Response("Bad request", { status: 400 });

  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });
  const page = store.sitePages.find((p) => p.id === pageId) ?? null;
  const go = (path: string) => new Response(null, { status: 303, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });
  const back = (status: string) =>
    go(page ? `/@${store.handle}/${page.slug}?form=${formId}&status=${status}${mark ? `&f=${mark}` : ""}#form-${formId}` : `/@${store.handle}`);

  const def = store.suspended ? null : await readForm(store.statsId, formId).catch(() => null);
  if (!def || !store.statsId) return back("closed");
  // Before it opens or after it closes, nothing is taken (639 [GL7](26)).
  if (formOpen(def, Math.floor(Date.now() / 1000)) !== "open") return back("closed");
  const statsId = store.statsId;
  // A scored quiz's total rides along in the address, as the result does: numbers the page checks, never anybody's answers.
  const done = (outcome: string, joined: boolean, scored = "") =>
    `/@${store.handle}/form/${def.id}?p=${page?.id ?? ""}${outcome ? `&r=${outcome}${scored}` : ""}${joined ? "&j=1" : ""}${mark ? `&f=${mark}` : ""}`;

  // A field no person can see: whatever filled it in is told it worked, and nothing is kept.
  if (one("website").trim()) return go(done("", false));

  const ip = clientAddress(request);
  const room = await withinStore("form-ip", `${statsId}:${ip}`, PER_HOUR, 3_600, store).catch(unknownLimit);
  if (room === "unknown") return back("error");
  if (!room) return back("limited");

  const read = readAnswers(def, (name) => form.getAll(name).filter((v): v is string => typeof v === "string").map((v) => v.slice(0, 4_000)));
  if (!read.ok) return back(read.error);
  const outcome = outcomeOf(def, read.answers);
  // A scored quiz keeps its total with the answers only when something was scored, as its result is.
  const score = scoreOf(def, read.answers);
  const measured = score && score.answered > 0 ? score : null;

  try {
    // The list, only when they checked the box: the email that asks them to confirm, never the list itself.
    let joined = false;
    if (def.offerList && one("consent") === "yes" && read.email) {
      const lead = await leadAffiliate(store, "signup", visitCookies(request, store.handle), read.email);
      const asked = await askToJoin({ store, email: read.email, ip, origin: linkOrigin(request, store), fromForm: true, formId: def.id, formOutcome: outcome?.id, lead }).catch(() => "error" as const);
      joined = asked === "sent";
    }
    await addResponse(statsId, def.id, { id: randomBytes(16).toString("hex"), at: Math.floor(Date.now() / 1000), page: page?.id ?? "", answers: read.answers, outcome: outcome?.id ?? "", joined, ...(measured ? { score: measured.total, scores: measured.categories } : {}) }, store);
    // Somebody already on the list: the sequences that start with this form start now (lib/flows.ts checks they may be written to).
    if (read.email) await enroll(store, read.email, { joined: false, form: def.id, formOutcome: outcome?.id ?? "" });

    // A step of a funnel: counted as done there, and the person goes on.
    const here = page && mark ? await funnelHere(store, mark, "page", page.id).catch(() => null) : null;
    if (here && !(await isStorePeople(request, store).catch(() => false))) {
      await countFunnelDone(statsId, here.funnel, here.index, funnelVisitor(statsId, here.funnel.id, ip, request.headers.get("user-agent") ?? ""));
    }
    // A result, or the box's email, is said on a page of its own first; otherwise straight on.
    if (here?.next && !outcome && !joined) return go(here.next);
    return go(done(outcome?.id ?? "", joined, measured ? scoreQuery(measured) : ""));
  } catch (error) {
    // No room in the store's data room: the answers were not kept (lib/store-data.ts).
    if (error instanceof DataRoomError) return back("noroom");
    console.error("keeping a form's answers failed", error);
    return back("error");
  }
}
