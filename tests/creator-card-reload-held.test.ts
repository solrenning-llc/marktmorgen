// After a reload, the studio offers Delete for every kept card record, even one off with no name and one empty in
// every field, and never for a card that is not kept (Codex G's LOW on 117a8ea5d, #1963): the page passes `held`.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import StudioCardPage from "@/app/studio/card/page";
import { CreatorCardEditor } from "@/components/creator-card-editor";
import { answering } from "./security/next-headers";
import { POST } from "@/app/api/store/creator-card/route";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { NO_CARD, type CreatorCard } from "@/lib/creator-card";
import { CONTACT_WORDS } from "@/lib/buyer-words/contact";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const url = "https://marktmorgen.com/api/store/creator-card";

function editorProps(node: unknown): { initial: unknown; held?: unknown } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = editorProps(child);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const n = node as { type?: unknown; props?: { initial: unknown; held?: unknown; children?: unknown } };
    return n.type === CreatorCardEditor ? n.props : editorProps(n.props?.children);
  }
  return undefined;
}

function deleteShown(initial: CreatorCard, held: boolean | undefined): boolean {
  const html = renderToStaticMarkup(createElement(CreatorCardEditor, { initial, held, handle: "synthetic", storeName: "Synthetic", words: CONTACT_WORDS.en.card, address: "example.com/@synthetic/contact", look: { className: "st-page", style: {}, lang: "en" } }));
  return html.includes(">Delete the card<");
}

async function main() {
  const cases: { label: string; card: CreatorCard; held: boolean }[] = [
    { label: "off, no name, an email and a note kept", card: { ...NO_CARD, email: "kept@example.test", note: "Private words" }, held: true },
    { label: "a record empty in every field", card: { ...NO_CARD }, held: true },
    { label: "a named card", card: { ...NO_CARD, name: "Kept name" }, held: true },
    { label: "no card kept", card: { ...NO_CARD }, held: false },
  ];
  for (const c of cases) {
    redis.clear();
    const email = "card-reload-held@example.test";
    await claimHandle(email, "cardreloadheld", "Synthetic shop", "");
    await ensureStatsId(email);
    await ensureStoreId(email);
    await setSubscription(email, { customerId: "cus_CardReloadHeld", subscriptionId: "sub_CardReloadHeld", active: true, tier: "creator", period: paidPeriod() });
    const store = (await storeForEmail(email))!;
    const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
    if (c.held) {
      const saved = await POST(new NextRequest(url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "save", ...c.card }) }));
      is(`${c.label}: saved`, saved.status, 200);
    }
    answering(new NextRequest(url, { headers: { cookie } }));
    const props = editorProps(await StudioCardPage({ searchParams: Promise.resolve({ store: store.sid }) }));
    is(`${c.label}: the page seeds the card as read`, props?.initial, c.card);
    is(`${c.label}: the page says whether it is kept`, props?.held, c.held);
    is(`${c.label}: Delete is offered only for a kept card`, deleteShown(c.card, c.held), c.held);
  }
  // Without `held` (an older caller), any word kept or the card on still offers Delete.
  is("no held: hidden words offer Delete", deleteShown({ ...NO_CARD, note: "Private words" }, undefined), true);
  is("no held: an empty card offers none", deleteShown(NO_CARD, undefined), false);
  done();
}

void main();
