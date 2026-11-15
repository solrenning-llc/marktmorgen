/**
 * 568 [GD2] (c), letters: a sent email that poses as Marktmorgen is not published on the store.
 *
 * A published email is a page of the store on marktmorgen.com that anybody may be sent to, so one reading
 * "Marktmorgen Support: verify your account" is a phishing page with our name on it. List emails are held to the rule
 * when they are sent (unit 6); one sent before that is held to it here. With the real route on the in-memory database
 * and a real session (app/api/store/letters, action "publish"):
 *
 *   - an email whose subject or text poses is refused with "brand_imitation", the studio's sentence (where, the
 *     passage, why and the fix) and the passage; nothing is published, for everyone or for members, and the email is
 *     not changed;
 *   - a plain email, saying the store runs on Marktmorgen and the protective opposite are published as before;
 *   - the publish control shows the server's sentence in its existing alert.
 *
 * Synthetic store and emails only; nothing is sent.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readBroadcast, type Broadcast } from "@/lib/broadcasts";
import { letterIdFor, letterImitation, readLetter } from "@/lib/letters";
import { IMITATION_FIX, imitationWhy } from "@/lib/brand-imitation-rules";
import { POST as lettersRoute } from "@/app/api/store/letters/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "posing.letters@example.com";
const LETTER_WHY = imitationWhy("the email cannot be published with it");

function sentEmail(store: Store, id: string, subject: string, body: string): Broadcast {
  const b: Broadcast = {
    id: id.padStart(24, "0"),
    listId: store.listId!,
    handle: store.handle,
    subject,
    body,
    productId: null,
    notProductId: null,
    who: "all",
    narrow: null,
    status: "sent",
    createdAt: 1_760_000_000,
    sendAt: 1_760_000_100,
    finishedAt: 1_760_000_200,
    total: 12,
    sent: 12,
    note: "",
    failures: 0,
    listed: true,
    tagged: true,
    test: null,
  };
  redis.run(["SET", `nl:mail:bc:${b.id}`, JSON.stringify(b)]);
  return b;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "posingletters", "Posing Letters", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PosingLetters", subscriptionId: "sub_PosingLetters", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const publish = async (email: Broadcast, extra: Record<string, unknown> = {}) => {
    const r = await lettersRoute(new NextRequest("https://marktmorgen.com/api/store/letters", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "publish", id: email.id, ...extra }) }));
    return { status: r.status, body: (await r.json()) as { ok?: boolean; error?: string; message?: string; path?: string; passage?: { field?: string; excerpt?: string; why?: string; fix?: string } } };
  };
  const published = async (email: Broadcast) => (await readLetter(store, letterIdFor(store.sid!, email.id))) !== null;

  part("A plain email is published");
  const plain = sentEmail(store, "a1", "October notes", "The new workbook is out. The store runs on Marktmorgen, as before.");
  const made = await publish(plain);
  is("published", [made.status, made.body.ok, await published(plain)], [200, true, true]);

  part("An email that poses is refused, and nothing is published");
  const subject = sentEmail(store, "a2", "Marktmorgen Support: action needed", "Hello.");
  const bySubject = await publish(subject);
  is(
    "a subject posing as Marktmorgen's staff: the part, the passage, why for a published email and the fix",
    [bySubject.status, bySubject.body.error, bySubject.body.passage?.field, bySubject.body.passage?.excerpt?.includes("Marktmorgen Support"), bySubject.body.passage?.why, bySubject.body.passage?.fix, await published(subject)],
    [409, "brand_imitation", "subject", true, LETTER_WHY, IMITATION_FIX, false],
  );
  is(
    "the studio's sentence: not published, where, the passage, why, the fix, nothing changed",
    bySubject.body.message,
    `This email was not published. In the subject line: “${bySubject.body.passage?.excerpt}”. ${LETTER_WHY} ${IMITATION_FIX} Nothing you wrote was changed.`,
  );
  const locked = sentEmail(store, "a3", "About your order", "Your Marktmorgen account has been suspended. Verify your account to keep it.");
  is("its account in trouble, in the text", [(await publish(locked)).body.error, await published(locked)], ["brand_imitation", false]);
  const link = sentEmail(store, "a4", "Your files", "Download them at https://marktmorgen.com.files-now.io/get");
  is("a look-alike address in the text", [(await publish(link)).body.passage?.field, await published(link)], ["body", false]);
  const members = await publish(locked, { products: [], open: true });
  is("for everyone on purpose, the same", [members.status, members.body.error, await published(locked)], [409, "brand_imitation", false]);
  is("the email itself is not changed", (await readBroadcast(locked.id))?.body, locked.body);

  part("The protective opposite is published");
  const opposite = sentEmail(store, "a5", "A note on safety", "Marktmorgen will never ask for your password. Neither will I.");
  is("published", [(await publish(opposite)).body.ok, await published(opposite)], [true, true]);

  part("The rule itself, and the control");
  is("letterImitation: none, the subject, the text", [letterImitation(plain), letterImitation(subject)?.field, letterImitation(locked)?.field], [null, "subject", "body"]);
  is("the publish control shows the server's sentence in its alert", /if \(data\.ok !== true\) setError\(data\.message \?\? SERVER_ERROR\);/.test(readFileSync("components/letter-publish-control.tsx", "utf8")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
