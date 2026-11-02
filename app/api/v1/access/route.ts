import { apiAdder, apiError, apiOk, apiWriter, readApiBody } from "@/lib/api-guard";
import { WRITE_ERRORS, giveAccess, takeAccess, roomFor } from "@/lib/api-write";

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
  try {
    const done = await roomFor(() => giveAccess(writer.store, writer.keyId, body));
    if (!done.ok) return apiError(WRITE_ERRORS[done.error][0], done.error, done.message ?? WRITE_ERRORS[done.error][1]);
    return apiOk({ data: done.value });
  } catch (error) {
    console.error("api: giving a product failed", error);
    return apiError(502, "unavailable", "The product could not be given just now. Try again in a moment.");
  }
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
