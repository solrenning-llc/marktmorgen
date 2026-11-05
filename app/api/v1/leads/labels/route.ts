import { apiAdder, apiError, apiOk } from "@/lib/api-guard";
import { WRITE_ERRORS, addsLabels, changeLeadLabels, roomFor } from "@/lib/api-write";

/**
 * POST /api/v1/leads/labels — adds and takes away labels of somebody on the
 * list: `{ "email", "add": [...], "remove": [...] }`. A label added starts the
 * sequences it starts in the studio (lib/api-write.ts). A key that may write only.
 */
export async function POST(request: Request) {
  // 232 [CA1] unit 4c: waits while the plan's renewal is unpaid or a payment for it is disputed.
  const writer = await apiAdder(request, addsLabels);
  if (writer instanceof Response) return writer;
  const body = writer.body;
  try {
    const done = await roomFor(() => changeLeadLabels(writer.store, body));
    if (!done.ok) return apiError(WRITE_ERRORS[done.error][0], done.error, done.message ?? WRITE_ERRORS[done.error][1]);
    return apiOk({ data: done.value });
  } catch (error) {
    console.error("api: changing labels failed", error);
    return apiError(502, "unavailable", "The labels could not be changed just now. Try again in a moment.");
  }
}
