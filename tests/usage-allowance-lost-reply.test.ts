/**
 * The delivery allowance notice (app/api/cron/usage/route.ts) after a provider answer that was lost (Codex L's
 * MEDIUM on #4529, app/api/cron/usage/route.ts:343): the provider may have accepted the notice and only its answer
 * did not come back. The store was left off the told list, so the next run in the same period wrote to its owner
 * again. A notice that went out or may have gone out holds the store on the told list; only a certain refusal takes
 * it off, so it is tried again. Synthetic only: the Redis stub and the SES mail fixture.
 */
import { recordDelivery, rememberFolderOwner, DELIVERY_ALLOWANCE_BYTES } from "@/lib/delivery";
import { GET } from "@/app/api/cron/usage/route";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

delete process.env.RESEND_API_KEY;
delete process.env.CRON_SECRET;

const fixture = installSesMailFixture();
fixture.configure();
const request = { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof GET>[0];
const run = async () => ((await (await GET(request)).json()) as Record<string, unknown>);
const triedTo = (address: string) => fixture.sesAttempts.filter((m) => m.to.includes(address)).length;
async function toldList(): Promise<string[]> {
  const [raw] = await redis.pipeline([["GET", "nl:usage-watch:told"]]);
  return typeof raw === "string" ? (JSON.parse(raw) as string[]) : [];
}
const folder = (c: string) => c.repeat(32);
async function overAllowance(f: string, owner: string): Promise<void> {
  await rememberFolderOwner(f, owner);
  await recordDelivery(`stores/${f}/prod01/file.zip`, DELIVERY_ALLOWANCE_BYTES + 1024);
}

async function main(): Promise<void> {
  part("The notice may have been accepted, its answer lost: the next run in the same period does not write again");
  redis.clear();
  fixture.reset();
  await overAllowance(folder("a"), "lost@example.com");
  fixture.setSesOutcome(["lost"]);
  const first = await run();
  is("first run: one submission, not counted as told", [triedTo("lost@example.com"), first.told], [1, 0]);
  is("the store is held on the told list", (await toldList()).includes(folder("a")), true);
  fixture.setSesOutcome("ok");
  await run();
  is("the next run makes no second submission", triedTo("lost@example.com"), 1);

  part("Control: a certain refusal is tried again");
  redis.clear();
  fixture.reset();
  await overAllowance(folder("b"), "refused@example.com");
  fixture.setSesOutcome(["refused"]);
  const refused = await run();
  is("first run: refused, not told, not on the list", [triedTo("refused@example.com"), refused.told, (await toldList()).includes(folder("b"))], [1, 0, false]);
  fixture.setSesOutcome("ok");
  const again = await run();
  is("the next run writes to the owner", [triedTo("refused@example.com"), again.told, (await toldList()).includes(folder("b"))], [2, 1, true]);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
