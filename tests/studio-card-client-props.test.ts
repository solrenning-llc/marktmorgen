// /studio/card answered 500 for every creator (VR site sweep, 12/11/2026): the server page handed the client editor
// the card's words, whose `store` is a function, and React refuses to pass a function to a client component
// ("Functions cannot be passed directly to Client Components", minified error #441 in the browser). Every prop the
// page passes to CreatorCardEditor must be plain data a server can send; the editor reads the words from `language`.
import { NextRequest } from "next/server";
import StudioCardPage from "@/app/studio/card/page";
import { CreatorCardEditor } from "@/components/creator-card-editor";
import { contactWords } from "@/lib/buyer-words/contact";
import { answering } from "./security/next-headers";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
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

/** Paths of every value a server could not send to a client component: functions, symbols, class instances. */
function unsendable(value: unknown, path: string, out: string[]): string[] {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") out.push(path);
  else if (Array.isArray(value)) value.forEach((item, n) => unsendable(item, `${path}[${n}]`, out));
  else if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) out.push(`${path} (${proto?.constructor?.name ?? "unknown"})`);
    else for (const [key, item] of Object.entries(value)) unsendable(item, `${path}.${key}`, out);
  }
  return out;
}

async function main() {
  redis.clear();
  const email = "card-client-props@example.test";
  await claimHandle(email, "cardclientprops", "Synthetic shop", "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  await setSubscription(email, { customerId: "cus_CardClientProps", subscriptionId: "sub_CardClientProps", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
  answering(new NextRequest("https://marktmorgen.com/studio/card", { headers: { cookie } }));
  const props = editorProps(await StudioCardPage({ searchParams: Promise.resolve({ store: store.sid }) }));
  is("the page draws the card editor", Boolean(props), true);
  is("every prop the page passes to the client editor can be sent from the server", unsendable(props, "props", []), []);
  is("the editor is given the store's language, from which it reads the card's words", props?.language, store.language);
  // The guard itself catches what broke the page: the words object with its `store` function.
  is("a function in the props is caught", unsendable({ words: contactWords("en").card }, "props", []), ["props.words.store"]);
  done();
}

void main();
