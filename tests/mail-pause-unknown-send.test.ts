/**
 * A store's sending pause read in an unknown shape is never "no pause" on a send path (Claude 6's MEDIUM on #2687,
 * 7057898559; CX-123 rule 24). The import's mail step (lib/imports.ts) and the API's access email (lib/api-write.ts)
 * read the pause through pauseForSending: undefined (a thrown or malformed read) means try again later or send
 * nothing, as lib/mail.ts and the move reminders already do. Synthetic store, the tests' in-memory Redis, a stubbed
 * Resend; a real pause (30 bounces of 1,000) is stored and only its read fails.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { IMPORT_KEEP_SECONDS, runImport, type ImportJob } from "@/lib/imports";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Command = (string | number)[];
type Sent = { to: string | string[] };
const emails: Sent[] = [];
const real = redis.pipeline.bind(redis);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url}` } }), { status: 404 });
}) as typeof fetch;

const pauseKey = (sid: string) => `nl:mail:paused:${sid}`;
const PAUSE = (now: number) => JSON.stringify({ reason: "bounces", until: Math.floor(now / 1000) + 86_400, sent: 1000, count: 30 });

/** Runs `action` with every read of `key` throwing, as a lost or refused Redis reply would. */
async function withUnreadable<T>(key: string, action: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.some((c) => c[0] === "GET" && c[1] === key)) throw new Error("synthetic unreadable pause");
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return await action();
  } finally {
    redis.pipeline = real;
  }
}

const call = async (key: string, body: unknown) => {
  const response = await postAccess(
    new Request("https://marktmorgen.com/api/v1/access", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  );
  return (await response.json()) as { error?: string; data?: { emailed?: boolean; status?: string } };
};

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_mail_pause_unknown_only";

  part("The API's access email: an unknown pause sends nothing");
  redis.clear();
  const OWNER = "pause-unknown@example.com";
  await claimHandle(OWNER, "pause-unknown", "Pause Unknown Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PauseUnknown1", subscriptionId: "sub_PauseUnknown1", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  const guide = await addProduct(OWNER, "The Guide", "", "12", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  const store = (await storeForEmail(OWNER))!;
  const writer = await makeKey(store.sid, "Zapier", Date.now(), true);
  if (!writer.ok) throw new Error("no key");
  // Whether the call reached the email: its reservation of the store's mail month (lib/mail.ts reserveDay and
  // reserveMoved run only after the pause check), read from the commands it sends.
  const reached = async (email: string, unreadable: boolean) => {
    let reservations = 0;
    const action = () => call(writer.key, { email, product: guide.product.id, notify: true });
    const counting = (async (commands: Command[]) => {
      if (commands.some((c) => c[0] === "INCRBY" && /^nl:(mail:used|imports:moved):/.test(String(c[1])))) reservations += 1;
      if (unreadable && commands.some((c) => c[0] === "GET" && c[1] === pauseKey(store.sid))) throw new Error("synthetic unreadable pause");
      return real(commands);
    }) as typeof redis.pipeline;
    redis.pipeline = counting;
    try {
      const answer = await action();
      return { status: answer.data?.status, emailed: answer.data?.emailed, reservations };
    } finally {
      redis.pipeline = real;
    }
  };
  is("no pause, read exactly: the email is reserved for (healthy control)", (await reached("cal@example.com", false)).reservations > 0, true);
  await real([["SET", pauseKey(store.sid), PAUSE(Date.now()), "EX", 86_400]]);
  is("a pause read exactly: given, no email reserved or sent (control)", await reached("ben@example.com", false), { status: "given", emailed: false, reservations: 0 });
  is("a pause read in an unknown shape: given, no email reserved or sent", await reached("ann@example.com", true), { status: "given", emailed: false, reservations: 0 });

  part("The import's mail step: an unknown pause takes nobody off the queue");
  redis.clear();
  const IMPORTER = "pause-unknown-import@example.com";
  await claimHandle(IMPORTER, "pause-unknown-import", "Pause Unknown Import", "");
  await ensureStatsId(IMPORTER);
  await ensureListId(IMPORTER);
  await setSubscription(IMPORTER, { customerId: "cus_PauseUnknown2", subscriptionId: "sub_PauseUnknown2", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  const sid = (await storeForEmail(IMPORTER))!.sid;
  const id = "8".repeat(24);
  const job: ImportJob = {
    id,
    kind: "purchases",
    sid,
    by: IMPORTER,
    at: Date.now(),
    state: "mailing",
    file: "buyers.csv",
    expected: 3,
    total: 3,
    done: 3,
    cursor: { batch: 0, row: 0 },
    counts: { added: 3, already: 0, skipped: 0, errors: 0, mailed: 0, unmailed: 0, contacts: 0, stopped: 0 },
    options: { agreed: false, consentColumn: false, tags: [], email: true, dateOrder: "", source: "csv" },
    finishedAt: 0,
  };
  const mail = `nl:import:${id}:mail`;
  await real([
    ["SET", `nl:import:${id}`, JSON.stringify(job), "EX", IMPORT_KEEP_SECONDS],
    ["SADD", "nl:imports:active", id],
    ["SADD", mail, "ann@example.com", "ben@example.com", "cal@example.com"],
    ["EXPIRE", mail, IMPORT_KEEP_SECONDS],
    ["SET", `nl:imports:busy:${sid}`, id, "EX", 3600],
    ["SET", pauseKey(sid), PAUSE(Date.now()), "EX", 86_400],
  ]);
  emails.length = 0;
  const after = await withUnreadable(pauseKey(sid), () => runImport(id, Date.now() + 30_000));
  is("still mailing, all three still queued, nobody emailed", [after?.state, Number((await real([["SCARD", mail]]))[0]), emails.length], ["mailing", 3, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
