import { apiAdder, apiError, apiOk, apiWriter, readApiBody } from "@/lib/api-guard";
import { WRITE_ERRORS, giveAccess, takeAccess, roomFor } from "@/lib/api-write";
import { KEYED_WRITE_LARGEST, onceForKey } from "@/lib/api-idempotency";

/**
 * POST /api/v1/access — gives a product to an address with no payment, as an
 * import of past buyers does: `{ "email", "product", "notify" }`.
 * DELETE /api/v1/access — takes back one the API gave: `{ "email", "product" }`.
 * A key that may write only (lib/api-write.ts).
 */
export async function POST(request: Request) {
  // 232 [CA1] unit 4c: waits while the plan's renewal is unpaid or a payment for it is disputed.
  const writer = await apiAdder(request);
  if (writer instanceof Response) return writer;
  const body = writer.body;
  // An Idempotency-Key makes a repeat give back the first answer instead of giving the product again (lib/api-idempotency.ts).
  return onceForKey(request, writer.store.sid, "/api/v1/access", body, KEYED_WRITE_LARGEST, async () => {
    try {
      const done = await roomFor(() => giveAccess(writer.store, writer.keyId, body));
      // A refusal changed nothing, so its key is let go; a product given (or already held) keeps its answer.
      if (!done.ok) return { response: apiError(WRITE_ERRORS[done.error][0], done.error, done.message ?? WRITE_ERRORS[done.error][1]), effect: "none" };
      return { response: apiOk({ data: done.value }), effect: "done" };
    } catch (error) {
      console.error("api: giving a product failed", error);
      return { response: apiError(502, "unavailable", "The product could not be given just now. Try again in a moment."), effect: "maybe" };
    }
  }, typeof body.email === "string" ? body.email : undefined);
}

export async function DELETE(request: Request) {
  const writer = await apiWriter(request);
  if (writer instanceof Response) return writer;
  const body = await readApiBody(request);
  if (body instanceof Response) return body;
  try {
    const done = await takeAccess(writer.store, body);
    if (!done.ok) return apiError(WRITE_ERRORS[done.error][0], done.error, done.message ?? WRITE_ERRORS[done.error][1]);
    return apiOk({ data: { ...done.value, status: "taken_back" } });
  } catch (error) {
    console.error("api: taking a product back failed", error);
    return apiError(502, "unavailable", "The product could not be taken back just now. Try again in a moment.");
  }
}
