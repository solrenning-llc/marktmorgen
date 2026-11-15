import type { NextRequest } from "next/server";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { can } from "@/lib/team-roles";
import { keepStoreSetupWithSteps } from "@/lib/store-setup";

/**
 * Keeps what the creator chose from the AI's first draft of their store:
 * `{ bio, products: [{ title, summary, kind, price }], faq }`, each part
 * optional (lib/store-setup.ts). Needs both the products and the page.
 * Answers what was kept (`done`) and what is still missing before it can
 * sell (`steps`, 219 [OP5] unit 7); nothing is published here.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 10_000);
  if (!guarded.ok) return guarded.response;
  const { ref, store, role, body } = guarded;
  if (!can(role, "page")) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  try {
    const { done, steps } = await keepStoreSetupWithSteps(ref, store, body);
    return Response.json({ ok: true, done, steps });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("keeping the drafted store failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
