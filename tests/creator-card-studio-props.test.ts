/**
 * VR (owner, 25/10/2026, Part A item 2), found by Claude 4 on 11/11/2026 with
 * the real production build: the studio's Business card page
 * (app/studio/card/page.tsx) answered 500 for every creator whose card could
 * be read, because it handed the client editor the contact words with their
 * `store` function in them, and a server page cannot pass a function to a
 * client component ("Functions cannot be passed directly to Client
 * Components"). Rendering in a test does not cross that boundary, so this
 * walks what the page hands the editor and fails on any value React cannot
 * send to the browser.
 */
import { NextRequest } from "next/server";
import StudioCardPage from "@/app/studio/card/page";
import { CreatorCardEditor } from "@/components/creator-card-editor";
import { answering } from "./security/next-headers";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { saveCreatorCard } from "@/lib/creator-card";
import { claimHandle, ensureStatsId, ensureStoreId, setLanguage, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

function editorProps(node: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = editorProps(child);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const n = node as { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
    return n.type === CreatorCardEditor ? n.props : editorProps(n.props?.children);
  }
  return undefined;
}

/** Every path in a value that React could not send from a server page to a client component. */
function notSendable(value: unknown, path = "props"): string[] {
  if (typeof value === "function" || typeof value === "symbol") return [path];
  if (Array.isArray(value)) return value.flatMap((item, i) => notSendable(item, `${path}[${i}]`));
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return [`${path} (${proto?.constructor?.name ?? "class"})`];
    return Object.entries(value).flatMap(([key, item]) => notSendable(item, `${path}.${key}`));
  }
  return [];
}

async function main() {
  for (const language of ["en", "pt"] as const) {
    redis.clear();
    const email = `card-props-${language}@example.test`;
    await claimHandle(email, `cardprops${language}`, "Synthetic Pottery", "");
    await ensureStatsId(email);
    await ensureStoreId(email);
    await setSubscription(email, { customerId: "cus_CardProps", subscriptionId: "sub_CardProps", active: true, tier: "creator", period: paidPeriod() });
    if (language === "pt") await setLanguage(email, "pt");
    const store = (await storeForEmail(email))!;
    await saveCreatorCard(store.statsId!, { on: true, name: "Synthetic Name", title: "", email: "card@example.test", phone: "", website: "", note: "" }, store);
    answering(new NextRequest("https://marktmorgen.com/studio/card", { headers: { cookie: `${SESSION_COOKIE}=${await openSession(email)}` } }));
    const props = editorProps(await StudioCardPage({ searchParams: Promise.resolve({ store: store.sid }) }));
    is(`${language}: the page hands the card to the editor`, Boolean(props), true);
    // `children` is React's own; everything else crosses to the browser.
    const { children: _children, ...sent } = props ?? {};
    is(`${language}: nothing the editor gets is a function or a class (it would answer 500)`, notSendable(sent), []);
    const words = sent.words as Record<string, unknown> | undefined;
    is(`${language}: the way back to the store is named in the store's language, as on the public card`, sent.visit, language === "pt" ? "Visitar Synthetic Pottery" : "Visit Synthetic Pottery");
    is(`${language}: the words keep every label the preview shows`, ["pageTitle", "save", "saveHint", "email", "phone", "website"].every((key) => typeof words?.[key] === "string"), true);
  }
  done();
}

void main();
