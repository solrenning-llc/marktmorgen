// A deletion is announced only when no card is kept at all (Codex G on #1963, M2): the route says `removed`, and the
// editor checks it with every field empty, never only `on` and the name.
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/creator-card/route";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { NO_CARD, readCreatorCardHeld } from "@/lib/creator-card";
import { confirmedRemoval } from "@/components/creator-card-editor";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is } from "./check";

const url = "https://marktmorgen.com/api/store/creator-card";

async function main() {
  redis.clear();
  const email = "card-remove-confirmed@example.test";
  await claimHandle(email, "cardremoveok", "Synthetic shop", "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  await setSubscription(email, { customerId: "cus_CardRemoveOk", subscriptionId: "sub_CardRemoveOk", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
  const post = (body: Record<string, unknown>) => POST(new NextRequest(url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

  // A card kept off, with no name, but with hidden words: it is still a kept card.
  const hidden = { on: false, name: "", title: "", email: "kept@example.test", phone: "", website: "", note: "Private words" };
  is("a hidden-words card saves", (await post({ action: "save", ...hidden })).status, 200);
  is("it is held", (await readCreatorCardHeld(store.statsId)).held, true);

  const removed = await post({ action: "remove" });
  const answer = (await removed.json()) as { ok: boolean; removed: unknown; card: unknown };
  is("removal answers 200", removed.status, 200);
  is("removal says removed", answer.removed, true);
  is("removal sends the empty card", answer.card, NO_CARD);
  is("nothing is held after", (await readCreatorCardHeld(store.statsId)).held, false);

  // The editor's rule, on the answers the route can give.
  is("editor: removed and empty is confirmed", confirmedRemoval({ card: NO_CARD, removed: true }), true);
  is("editor: removed false is not confirmed", confirmedRemoval({ card: NO_CARD, removed: false }), false);
  is("editor: hidden words kept is not confirmed", confirmedRemoval({ card: hidden, removed: undefined }), false);
  is("editor: a shown card kept is not confirmed", confirmedRemoval({ card: { ...NO_CARD, on: true, name: "Still public" }, removed: undefined }), false);
  done();
}

void main();
