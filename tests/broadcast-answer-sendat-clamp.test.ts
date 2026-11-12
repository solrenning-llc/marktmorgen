/**
 * Hunt: createBroadcast accepts a sendAt up to 60 s in the past and clamps it to now; broadcastAnswer requires the
 * saved sendAt to equal floor(input.sendAt / 1000), so a created campaign is reported as unconfirmed.
 */
import { broadcastAnswer } from "@/lib/broadcast-response";
import { done, is } from "./check";
const now = 1_800_000_000; // seconds
const input = { subject: "Hello", body: "Body text", productId: "", notProductId: "", who: "all", sendAt: (now - 20) * 1000 };
const created = { ok: true, broadcast: { id: "a".repeat(24), status: "scheduled", createdAt: now, sendAt: now, total: 5, sent: 0, subject: "Hello", body: "Body text", productId: null, notProductId: null, who: "all", narrow: null, test: null }, draftCleanupConfirmed: true };
const answer = broadcastAnswer(true, created, input);
is("a campaign createBroadcast saved (sendAt clamped to now) is confirmed", answer.ok, true);
done();
