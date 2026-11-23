/**
 * #5010 row 151 (Claude 6 z5v4's route envelope sweep, 23/11/2026): while no sender can take mail at all
 * (serviceMailKnownUnavailable: no Amazon SES, and no Resend key or no Resend fallback proof), a purchases
 * import's email step read its portion of addresses, took it off the queue, built every letter (the buyer's
 * imported purchases and the listings of each) and only then heard "retry" from sendBatch and put the
 * addresses back: 234 billed commands a step, on one studio request, against the step priced at
 * request("step", 13). Now the step asks first, with no IO, and waits with the queue untouched.
 *
 * Synthetic only: the real import route over the in-memory Redis double; a working Amazon SES from
 * tests/ses-mail-fixture.ts for the control. Nothing is sent anywhere.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as importPost } from "@/app/api/store/import/route";
import { installSesMailFixture } from "./ses-mail-fixture";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_import_mail_unavailable_only";
const ses = installSesMailFixture({ fallback: () => new Response("{}", { status: 404 }) });

const real = redis.pipeline.bind(redis);
let seen: string[] = [];
let measuring = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (measuring) for (const c of commands) seen.push(`${String(c[0]).toUpperCase()} ${String(c[1] ?? "")}`);
  return real(commands);
}) as typeof redis.pipeline;

async function store(owner: string, handle: string) {
  await claimHandle(owner, handle, `${handle} store`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1importmailun12", true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "scale", period: paidPeriod() });
  // An older store, so its mail is not held as a new sender's.
  for (const key of ((await real([["SCAN", 0, "MATCH", "nl:store:owner:*", "COUNT", 1000]]))[0] as [string, string[]])[1]) {
    const value = JSON.parse((await real([["GET", key]]))[0] as string);
    value.createdAt = "2024-01-01T00:00:00.000Z";
    await real([["SET", key, JSON.stringify(value)]]);
  }
  for (let i = 0; i < 2; i += 1) {
    const made = await addProduct(owner, `Spoon Course ${i}`, "", "40");
    if (made.ok) await setProductLink(owner, made.product.id, `https://example.com/guide-${i}`);
  }
  return `${SESSION_COOKIE}=${await openSession(owner)}`;
}

const post = async (cookie: string, body: Record<string, unknown>) => {
  const response = await importPost(new NextRequest("https://marktmorgen.com/api/store/import", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return (await response.json()) as { import?: { id: string; state: string; counts: { mailed: number; unmailed: number } } };
};

async function importWithEmail(owner: string, handle: string, rows: number) {
  const cookie = await store(owner, handle);
  const input = { kind: "purchases", source: "csv", expected: rows, agreed: true, consentColumn: false, tags: [], email: true, file: "buyers.csv" };
  const started = await post(cookie, { action: "start", ...input });
  const id = started.import!.id;
  await post(cookie, { action: "rows", id, rows: Array.from({ length: rows }, (_, i) => [String(i + 1), `buyer${i}@example.com`, `Spoon Course ${i % 2}`, "paid"]) });
  const finished = await post(cookie, { action: "finish", id });
  return { cookie, id, finished };
}

const queued = async (id: string) => Number((await real([["SCARD", `nl:import:${id}:mail`]]))[0]);

async function main(): Promise<void> {
  part("no sender can take mail: the step waits without building a letter");
  redis.clear();
  ses.disableSes();
  const down = await importWithEmail("unavailable@example.com", "importmaildown", 200);
  is("the import is still mailing after finish", down.finished.import?.state, "mailing");
  is("nobody was taken off the queue by finish", await queued(down.id), 200);
  seen = [];
  measuring = true;
  const step = await post(down.cookie, { action: "step", id: down.id });
  measuring = false;
  is("the step leaves the import mailing", step.import?.state, "mailing");
  is("every address is still queued", await queued(down.id), 200);
  is("no portion was read or taken from the queue", seen.filter((c) => /^(SRANDMEMBER|SREM) nl:import:/.test(c)), []);
  is("no imported purchase was read to build a letter", seen.filter((c) => c.startsWith("HGETALL nl:imp:buy:")).length, 0);
  is("the step stays within one studio request's commands (27)", seen.length <= 27 ? "within" : `${seen.length} commands`, "within");
  is("nothing was counted as sent or as not emailed", [step.import?.counts.mailed, step.import?.counts.unmailed], [0, 0]);

  part("a working sender: the same import still sends");
  redis.clear();
  ses.configure();
  await ses.setReady(true, { max24: 50_000, rate: 100 });
  const up = await importWithEmail("available@example.com", "importmailup", 50);
  is("finish sends the first portion and the import is done", [up.finished.import?.state, up.finished.import?.counts.mailed], ["done", 50]);
  is("Amazon was handed each buyer once", ses.sent.length, 50);
  done();
}

void main();
