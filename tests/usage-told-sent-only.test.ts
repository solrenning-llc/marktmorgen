/**
 * The delivery allowance notice (app/api/cron/usage/route.ts) is recorded as
 * given only when it was given.
 *
 * Section 5 of the Terms promises that a store far above the published limits
 * is written to first. The watch keeps one told list (nl:usage-watch:told) so
 * a store over the allowance is written to once, not every morning. Before
 * this, the list was written with every store over the allowance, whether its
 * notice went out or not: a notice the mail provider refused, one skipped
 * because no sender was configured, or a support notice about an ownerless
 * store that failed, was recorded as told and never sent again.
 *
 * Now only what was sent is recorded: a store whose owner was written to, and
 * an ownerless store once support was told about it. Everything else is tried
 * again on the next run. A store told once is still not told twice.
 *
 * An owner read that failed (Redis down, or a reply that is not a string) is
 * not "no owner" (rule 24): nobody is written to about that store, support is
 * not told it has no address, and it stays off the told list, so its owner is
 * written to on the next run, once the read works.
 *
 * So is kept text that is neither an address nor "#<store id>" (an account's
 * other store): "", whitespace, "not-an-owner". It is not a delivered notice
 * and not "no address on file": support is not told, nothing is recorded.
 * One store's unknown owner postpones that store only; the other stores in
 * the run are written to and recorded as usual.
 *
 * Synthetic only: the Redis stub and the SES mail fixture, no real IO.
 */
import { recordDelivery, rememberFolderOwner, DELIVERY_ALLOWANCE_BYTES } from "@/lib/delivery";
import { GET } from "@/app/api/cron/usage/route";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

delete process.env.RESEND_API_KEY;
delete process.env.CRON_SECRET;

/** Addresses Amazon refuses outright, for now; Resend stays closed without its reviewed proof. */
const refused = new Set<string>();
const fixture = installSesMailFixture({
  onSes: (message) => message.to.some((to) => refused.has(to))
    ? new Response(JSON.stringify({ message: "synthetic confirmed message refusal" }), {
        status: 400, headers: { "content-type": "application/json", "x-amzn-errortype": "BadRequestException" },
      })
    : undefined,
});
fixture.configure();
const delivered = (): string[] => fixture.sent.flatMap((m) => m.to);

/** Makes the owners' read (the GETs of nl:store:folder-owner:*) fail, answer off-shape, or answer this text. */
let ownerRead: "ok" | "throw" | "off-shape" | { text: string } = "ok";
const realPipeline = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = ((list: (string | number)[][]) => {
  const ownersOnly = list.length > 0 && list.every((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:folder-owner:"));
  if (ownersOnly && ownerRead === "throw") return Promise.reject(new Error("synthetic: Redis request failed with status 503"));
  if (ownersOnly && ownerRead === "off-shape") return Promise.resolve(list.map(() => 42));
  if (ownersOnly && typeof ownerRead === "object") {
    const text = ownerRead.text;
    return Promise.resolve(list.map(() => text));
  }
  return realPipeline(list);
}) as typeof redis.pipeline;

const request = { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof GET>[0];

async function run(): Promise<{ status: number; told: unknown; emails: string[]; unreadOwners: unknown }> {
  const from = delivered().length;
  const response = await GET(request);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, told: body.told, emails: delivered().slice(from), unreadOwners: body.unreadOwners };
}

async function toldList(): Promise<string[]> {
  const [raw] = await redis.pipeline([["GET", "nl:usage-watch:told"]]);
  return typeof raw === "string" ? (JSON.parse(raw) as string[]) : [];
}

const folder = (c: string) => c.repeat(32);
async function overAllowance(f: string, owner: string | null): Promise<void> {
  if (owner) await rememberFolderOwner(f, owner);
  await recordDelivery(`stores/${f}/prod01/file.zip`, DELIVERY_ALLOWANCE_BYTES + 1024);
}

async function main(): Promise<void> {
  part("healthy control: a notice that went out is recorded once and not sent again");
  redis.clear();
  fixture.reset();
  refused.clear();
  await overAllowance(folder("a"), "fine@example.com");
  const h1 = await run();
  is("the owner is written to", [h1.status, h1.told, h1.emails], [200, 1, ["fine@example.com"]]);
  is("and the store is in the told list", (await toldList()).includes(folder("a")), true);
  const h2 = await run();
  is("the next run writes to nobody", [h2.status, h2.told, h2.emails], [200, 0, []]);

  part("a notice the provider refused is not recorded, and is sent on the next run");
  redis.clear();
  fixture.reset();
  refused.clear();
  refused.add("down@example.com");
  await overAllowance(folder("b"), "down@example.com");
  const r1 = await run();
  is("first run: nothing went out", [r1.status, r1.told, r1.emails], [200, 0, []]);
  is("the store is not in the told list", (await toldList()).includes(folder("b")), false);
  refused.clear();
  const r2 = await run();
  is("next run, mail back: the owner is written to", [r2.told, r2.emails], [1, ["down@example.com"]]);
  is("now the store is in the told list", (await toldList()).includes(folder("b")), true);
  const r3 = await run();
  is("and the run after writes to nobody", [r3.told, r3.emails], [0, []]);

  part("two stores, one refused: only the one written to is recorded");
  redis.clear();
  fixture.reset();
  refused.clear();
  refused.add("second@example.com");
  await overAllowance(folder("c"), "first@example.com");
  await overAllowance(folder("d"), "second@example.com");
  const m1 = await run();
  is("one notice went out", [m1.told, m1.emails], [1, ["first@example.com"]]);
  const list = await toldList();
  is("the told list holds the sent one only", [list.includes(folder("c")), list.includes(folder("d"))], [true, false]);
  refused.clear();
  const m2 = await run();
  is("next run: only the refused one is written to", [m2.told, m2.emails], [1, ["second@example.com"]]);

  part("no sender configured: nothing is recorded as told");
  redis.clear();
  fixture.reset();
  refused.clear();
  fixture.disableSes();
  await overAllowance(folder("e"), "later@example.com");
  const n1 = await run();
  is("nothing went out", [n1.status, n1.told, n1.emails], [200, 0, []]);
  is("the store is not in the told list", (await toldList()).includes(folder("e")), false);
  fixture.configure();
  const n2 = await run();
  is("once a sender is there, the owner is written to", [n2.told, n2.emails], [1, ["later@example.com"]]);

  part("an ownerless store: recorded once support was told, retried when support was not");
  redis.clear();
  fixture.reset();
  refused.clear();
  refused.add(SUPPORT_EMAIL);
  await overAllowance(folder("f"), null);
  const o1 = await run();
  is("the support notice failed: nothing went out", o1.emails, []);
  is("the ownerless store is not in the told list", (await toldList()).includes(folder("f")), false);
  refused.clear();
  const o2 = await run();
  is("next run: support is told", o2.emails, [SUPPORT_EMAIL]);
  is("now the ownerless store is in the told list", (await toldList()).includes(folder("f")), true);
  const o3 = await run();
  is("and support is not told again", o3.emails, []);

  for (const failure of ["throw", "off-shape"] as const) {
    part(`the owners' read ${failure === "throw" ? "fails" : "answers off-shape"}: nobody is told, nothing recorded, the owner is written to next run`);
    redis.clear();
    fixture.reset();
    refused.clear();
    await overAllowance(folder("g"), "owner@example.com");
    ownerRead = failure;
    const u1 = await run();
    ownerRead = "ok";
    // The owners are read exactly (lib/delivery.ts ownersOf). A read that fails as a whole answers the delivery part
    // 503; one owner's answer off-shape postpones that store only (Claude 1's decision on 1975a5cd). Either way
    // nobody is written to about it and nothing is recorded.
    is("first run: nobody is written to (not the owner, not support)", [u1.status, u1.told, u1.emails],
      failure === "throw" ? [503, undefined, []] : [200, 0, []]);
    is("the store is not in the told list", (await toldList()).includes(folder("g")), false);
    const u2 = await run();
    is("next run, owner read back: the owner gets the notice", [u2.told, u2.emails], [1, ["owner@example.com"]]);
    is("now the store is in the told list", (await toldList()).includes(folder("g")), true);
  }

  // Codex Z's conditional residual (second review on be6355cd4, focal on 94d8b9b29): kept text that is neither an
  // address nor "#<store id>" is not evidence that the store has no owner (rule 24). It is unknown, like a failed
  // read: no notice is given, support is not told the store has no address, and nothing goes on the told list.
  for (const text of ["", " ", "\t\n", "not-an-owner", "#", "#not-a-store-id"]) {
    part(`the owner's key reads back as ${JSON.stringify(text)}: unknown, nobody is told, nothing recorded`);
    redis.clear();
    fixture.reset();
    refused.clear();
    await overAllowance(folder("h"), "owner@example.com");
    ownerRead = { text };
    const t1 = await run();
    ownerRead = "ok";
    is("first run: the store is postponed and nobody is written to (not support)", [t1.status, t1.told, t1.emails, t1.unreadOwners], [200, 0, [], 1]);
    is("the store is not in the told list", (await toldList()).includes(folder("h")), false);
    const t2 = await run();
    is("next run, owner read back: the owner gets the notice", [t2.told, t2.emails], [1, ["owner@example.com"]]);
    is("now the store is in the told list", (await toldList()).includes(folder("h")), true);
  }

  part("the owner's key holds such text: every run postpones it, support is never told, nothing recorded");
  redis.clear();
  fixture.reset();
  refused.clear();
  await overAllowance(folder("i"), null);
  await redis.pipeline([["SET", `nl:store:folder-owner:${folder("i")}`, "not-an-owner"]]);
  const k1 = await run();
  const k2 = await run();
  is("both runs postpone it and write to nobody", [k1.status, k1.emails, k1.unreadOwners, k2.status, k2.emails, k2.unreadOwners], [200, [], 1, 200, [], 1]);
  is("the store is not in the told list", (await toldList()).includes(folder("i")), false);

  part("control: an account's other store (key \"#<store id>\") is still ownerless, and support is told once");
  redis.clear();
  fixture.reset();
  refused.clear();
  await overAllowance(folder("j"), null);
  await redis.pipeline([["SET", `nl:store:folder-owner:${folder("j")}`, `#${"0123456789abcdef".repeat(2)}`]]);
  const s1 = await run();
  is("support is told about it", [s1.status, s1.emails], [200, [SUPPORT_EMAIL]]);
  is("and the store is in the told list", (await toldList()).includes(folder("j")), true);
  const s2 = await run();
  is("support is not told again", s2.emails, []);

  // Claude 1's decision on 1975a5cd: one store's unknown owner postpones that store only. The other stores in the
  // same run are written to and recorded as usual; the unknown one is neither, and is tried again next run.
  part("one store with an unreadable owner key and one healthy store in the same run: only the healthy one is told");
  redis.clear();
  fixture.reset();
  refused.clear();
  await overAllowance(folder("k"), null);
  await redis.pipeline([["SET", `nl:store:folder-owner:${folder("k")}`, "not-an-owner"]]);
  await overAllowance(folder("l"), "healthy@example.com");
  const b1 = await run();
  is("the healthy owner is written to, the other store is postponed", [b1.status, b1.told, b1.emails, b1.unreadOwners], [200, 1, ["healthy@example.com"], 1]);
  const both = await toldList();
  is("only the healthy store is in the told list", [both.includes(folder("l")), both.includes(folder("k"))], [true, false]);
  const b2 = await run();
  is("next run: the healthy owner is not written to again, the other store is still postponed", [b2.status, b2.told, b2.emails, b2.unreadOwners], [200, 0, [], 1]);
  await redis.pipeline([["SET", `nl:store:folder-owner:${folder("k")}`, "fixed@example.com"]]);
  const b3 = await run();
  is("once its key reads, the postponed owner gets the notice", [b3.told, b3.emails, b3.unreadOwners], [1, ["fixed@example.com"], 0]);
  const after = await toldList();
  is("and both stores are now in the told list", [after.includes(folder("l")), after.includes(folder("k"))], [true, true]);

  fixture.restore();
  done();
}

void main();
