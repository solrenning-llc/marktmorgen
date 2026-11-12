/**
 * The delivery allowance notice (app/api/cron/usage/route.ts) once per store per calendar month, as its comment and
 * Section 5 of the Terms promise (webhooks/cron audit, Claude 1, 12/11/2026). The told list was one key for all
 * months, rewritten with every new notice (the union of all told so far) and its 40-day expiry renewed each time,
 * while the list of stores over the allowance is per month (lib/delivery.ts, overKey). A store told in October that
 * goes over again in November was not written to while the list still named it: for as long as some other store
 * was told within 40 days, never again. Now the told list is the month's own.
 * Synthetic only: the Redis stub and the SES mail fixture, no real IO.
 */
import { recordDelivery, rememberFolderOwner, DELIVERY_ALLOWANCE_BYTES, monthKey } from "@/lib/delivery";
import { GET } from "@/app/api/cron/usage/route";
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

async function run(): Promise<{ status: number; told: unknown; emails: string[]; unreadOwners: unknown }> {
  const from = delivered().length;
  const response = await GET(request);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, told: body.told, emails: delivered().slice(from), unreadOwners: body.unreadOwners };
}

const folder = (c: string) => c.repeat(32);
async function overAllowance(f: string, owner: string | null): Promise<void> {
  if (owner) await rememberFolderOwner(f, owner);
  await recordDelivery(`stores/${f}/prod01/file.zip`, DELIVERY_ALLOWANCE_BYTES + 1024);
}

async function main(): Promise<void> {
  redis.clear();
  fixture.reset();
  const month = monthKey();
  const previous = monthKey(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15)));

  part("A store told last month goes over again this month");
  // As the watch left things after last month's notice: the one list of all months (before) and last month's own.
  await redis.pipeline([
    ["SET", "nl:usage-watch:told", JSON.stringify([folder("a")]), "EX", 40 * 86_400],
    ["SET", `nl:usage-watch:told:${previous}`, JSON.stringify([folder("a")]), "EX", 40 * 86_400],
  ]);
  await overAllowance(folder("a"), "again@example.com");
  const first = await run();
  is("its owner is written to this month", [first.status, first.told, first.emails], [200, 1, ["again@example.com"]]);

  part("Once a month: the next run writes to nobody");
  const second = await run();
  is("not written to twice in the month", [second.status, second.told, second.emails], [200, 0, []]);
  const [raw] = await redis.pipeline([["GET", `nl:usage-watch:told:${month}`]]);
  is("this month's own list names the store", typeof raw === "string" && (JSON.parse(raw) as string[]).includes(folder("a")), true);
  done();
}

main();
