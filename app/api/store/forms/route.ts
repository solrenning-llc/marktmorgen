import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { FORM_ID, badPoints, newFormId, parseForm, tierIssueText, tierIssues } from "@/lib/forms";
import { SENSITIVE_WHY, sensitiveFieldOf } from "@/lib/form-sensitive";
import { dropForm, readForm, writeForm } from "@/lib/form-store";
import { setSitePages } from "@/lib/store";

/** Twelve questions of eight options each, and six results, as JSON. */
const MAX_BODY_BYTES = 60_000;

/**
 * A store's forms, surveys and quizzes (lib/forms.ts): part of its public
 * pages, so what the "page" permission may change.
 *
 *   { form: { id?, name, fields, button, doneHeading, doneBody, outcomes, offerList, scoring?, categories? } }   saves one
 *   { action: "remove", id }                                                                 removes it and its answers
 *
 * A result's product is kept only when it is one of the store's. A scored
 * quiz is saved only when every option's points are a whole number from 0 to
 * MAX_POINTS and its score ranges cover every possible total exactly once
 * (lib/forms.ts, tierIssues): otherwise nothing is saved, and the reasons
 * come back in words.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, ref } = guarded;
  let store = guarded.store;
  try {
    if (!store.statsId) {
      // A store written before it had one is given its id with its pages.
      const marked = await setSitePages(ref, store.sitePages);
      if (!marked.ok || !marked.store.statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
      store = marked.store;
    }
    const statsId = store.statsId as string;

    if (body.action === "remove") {
      const id = text(body.id, 12);
      if (!FORM_ID.test(id)) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
      return (await dropForm(statsId, id, store)) ? Response.json({ ok: true }) : Response.json({ ok: false, error: "unknown" }, { status: 404 });
    }

    const raw = body.form && typeof body.form === "object" ? (body.form as Record<string, unknown>) : null;
    if (!raw) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    const asked = typeof raw.id === "string" && FORM_ID.test(raw.id) ? raw.id : "";
    const existing = asked ? await readForm(statsId, asked) : null;
    if (asked && !existing) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    const form = parseForm({ ...raw, id: existing?.id ?? newFormId(), updatedAt: Math.floor(Date.now() / 1000) });
    if (!form) return Response.json({ ok: false, error: text(raw.name, 60).trim() ? "fields" : "name" }, { status: 400 });
    if (badPoints(raw)) return Response.json({ ok: false, error: "points" }, { status: 400 });
    // What a scam asks for is never asked here (568 [GD2] (c)): refused before anything is written, naming the field.
    const sensitive = sensitiveFieldOf(form);
    if (sensitive) return Response.json({ ok: false, error: "sensitive", field: sensitive.label, why: SENSITIVE_WHY[sensitive.what] }, { status: 400 });
    const issues = tierIssues(form);
    if (issues.length) return Response.json({ ok: false, error: "tiers", issues: issues.map((issue) => tierIssueText(form, issue)) }, { status: 400 });
    // A result points at one of this store's products, or at none.
    const known = new Set(store.catalog.items.map((item) => item.id));
    form.outcomes = form.outcomes.map((o) => (o.product && !known.has(o.product) ? { ...o, product: "" } : o));
    if (!(await writeForm(statsId, form))) return Response.json({ ok: false, error: "full" }, { status: 400 });
    return Response.json({ ok: true, form });
  } catch (error) {
    console.error("saving a form failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
