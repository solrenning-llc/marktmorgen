/**
 * A session let in without its second step cannot turn on sale
 * notifications on a new phone (Claude 5's authentication audit, M3).
 *
 * Such a session (the emailed link alone with "reset", or the recovery
 * address) may not make an API key or download a list (lib/two-step.ts
 * LOCKED_NEEDS). A phone is the same door: once on, it is told every sale,
 * booking, report and affiliate (amount, product, time), and it is the
 * person's, not the session's, so "Log out of all devices", Cancel and the end
 * of the lock leave it on. Checked through app/api/store/phone with the
 * in-memory Redis:
 *
 *   - a locked session's "add" is answered "locked" and no device is kept,
 *     as its API key is;
 *   - what it may still do with the person's own devices (find, choose
 *     events, remove) stays open;
 *   - a session opened with the second step (or without two-step login) still
 *     turns a phone on.
 */
import { createECDH } from "node:crypto";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId } from "@/lib/store";
import { openSession } from "@/lib/auth";
import { lockedOut, openLockedSession } from "@/lib/two-step";
import { phoneView } from "@/lib/phone-alerts";
import { POST as phoneRoute } from "@/app/api/store/phone/route";
import { POST as keysRoute } from "@/app/api/store/api-keys/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const ORIGIN = "https://marktmorgen.com";
const curve = createECDH("prime256v1");
curve.generateKeys();
const keys = { p256dh: curve.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") };
const json = (path: string, body: unknown, session: string) =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { Host: "marktmorgen.com", Origin: ORIGIN, "Content-Type": "application/json", cookie: `nl_session=${session}`, "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130" },
    body: JSON.stringify(body),
  });
const subscription = (name: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys });

async function main(): Promise<void> {
  redis.clear();
  const owner = "owner@phone-locked.example";
  await claimHandle(owner, "phone-locked", "Phone Locked", "");
  const store = (await ensureStatsId(owner))!;
  const devices = async () => ((await phoneView(store, owner, "owner")) as { devices?: unknown[] }).devices?.length ?? 0;

  part("A locked session tries to turn on notifications on a new phone");
  const locked = await openLockedSession(owner, Date.now() + 7 * 86_400_000);
  const key = await keysRoute(json("/api/store/api-keys", { action: "create", name: "x" }, locked));
  is("its API key: refused, locked (as before)", [key.status, ((await key.json()) as { error?: string }).error], [403, "locked"]);
  const phone = await phoneRoute(json("/api/store/phone", { action: "add", subscription: subscription("locked"), events: ["sale"] }, locked));
  is("its phone: refused the same way, locked", [phone.status, ((await phone.json()) as { error?: string }).error], [403, "locked"]);
  is("and no device is kept", await devices(), 0);
  is("the action is held for a locked session by name, under the permission every team member has", lockedOut("member", "phone-add"), true);

  part("A session with its second step, or without two-step login, still turns a phone on");
  const open = await openSession(owner);
  // The route answers 500 here only because after() has no request scope in a test; the device is kept before it.
  await phoneRoute(json("/api/store/phone", { action: "add", subscription: subscription("owner"), events: ["sale"] }, open)).catch(() => null);
  is("one device kept", await devices(), 1);

  part("What a locked session may still do with the person's own devices stays open");
  const found = await phoneRoute(json("/api/store/phone", { action: "find", endpoint: subscription("owner").endpoint }, locked));
  const foundBody = (await found.json()) as { ok?: boolean; id?: string | null };
  is("it can find which device this browser is", [found.status, foundBody.ok, typeof foundBody.id], [200, true, "string"]);
  const removed = await phoneRoute(json("/api/store/phone", { action: "remove", id: foundBody.id }, locked));
  is("and remove one (a phone notifies less, never more)", [removed.status, await devices()], [200, 0]);
  done();
}

void main();
