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

const request = { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof GET>[0];

async function run(): Promise<{ status: number; told: unknown; emails: string[] }> {
  const from = delivered().length;
  const response = await GET(request);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, told: body.told, emails: delivered().slice(from) };
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

  fixture.restore();
  done();
}

void main();
