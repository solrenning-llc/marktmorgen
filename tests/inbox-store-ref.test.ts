/**
 * MM-SA-31 (docs/security-audit-2026-10-28.md): the inbox's "saved" and "chat" actions write
 * to the store the request was settled on (lib/studio-route.ts), never to the
 * owner's first store. A Support member of an owner's SECOND store has no role
 * on the first one; saving replies or switching the chat on the second store
 * must leave the first store exactly as it was.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/inbox/route";
import { claimHandle, createStore, ensureStatsId, setInboxSetting, setSubscription, storeForEmail, storeForId, storeRef } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { putMember } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const OWNER = "owner@example.com";
const MATE = "support.mate@example.com";
const paid = { active: true, tier: "creator" as const, cycle: "month" as const, subscriptionId: null, customerId: null, trialEnds: 0 };

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "firstshop", "First Shop", "Recipes.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, paid);
  await setInboxSetting(OWNER, { chat: false, saved: [{ id: "first1", title: "First store reply", text: "Kept by the first store." }] });
  const second = await createStore(OWNER, "secondshop", "Second Shop", "");
  if (!second.ok) throw new Error("no second store");
  const secondRef = storeRef(second.store);
  await ensureStatsId(secondRef);
  await setSubscription(secondRef, paid);
  const secondStore = (await storeForId(second.store.sid))!;
  await putMember(secondStore, MATE, "support");

  const sessions: Record<string, string> = { [OWNER]: await openSession(OWNER), [MATE]: await openSession(MATE) };
  const send = async (who: string, body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/inbox", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": second.store.sid, cookie: `${SESSION_COOKIE}=${sessions[who]}` }, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as { ok: boolean; error?: string } };
  };

  const saved = await send(MATE, { action: "saved", saved: [{ id: "mate01", title: "Second store reply", text: "Written on the second store." }] });
  is("the support member's save on the second store is accepted", saved.data.ok, true);
  const first = (await storeForEmail(OWNER))!;
  const after2 = (await storeForId(second.store.sid))!;
  is("the first store's saved replies are untouched", first.inbox.saved.map((s) => s.id), ["first1"]);
  is("the second store's saved replies hold what was saved", after2.inbox.saved.map((s) => s.id), ["mate01"]);

  const chat = await send(OWNER, { action: "chat", on: true });
  is("the owner's chat switch on the second store is accepted", chat.data.ok, true);
  is("the first store's chat stays off", (await storeForEmail(OWNER))!.inbox.chat, false);
  is("the second store's chat is on", (await storeForId(second.store.sid))!.inbox.chat, true);
  done();
}

void main();
