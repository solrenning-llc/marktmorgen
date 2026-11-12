/**
 * A push service stand-in for tests/low-stock-push.test.ts: every send is
 * kept, and the answer is the one the test sets (`answer`), so a device
 * whose subscription is over (410) can be told apart from one reached.
 */
export type Subscription = { endpoint: string; p256dh: string; auth: string };
export type PushFetchHooks = Record<string, unknown>;
export const pushes: { endpoint: string }[] = [];
export const answer = { ok: true, status: 201, gone: false };
const keys = { kid: "low-stock-test-key", publicKey: "test-public", privateKey: "test-private" };
export const vapidKeys = () => keys;
export const vapidKeysFor = (kid: string) => (kid === keys.kid ? keys : null);
export function readSubscription(raw: unknown): Subscription | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as { endpoint?: unknown; keys?: { p256dh?: string; auth?: string } };
  return typeof input.endpoint === "string" && input.keys ? { endpoint: input.endpoint, p256dh: input.keys.p256dh || "", auth: input.keys.auth || "" } : null;
}
export async function sendPush(subscription: Subscription) {
  pushes.push({ endpoint: subscription.endpoint });
  return { ok: answer.ok, status: answer.status, gone: answer.gone, error: answer.ok ? "" : "synthetic" };
}
