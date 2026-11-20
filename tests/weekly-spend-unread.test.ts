/**
 * The weekly email when the ad spend could not be read (#3297, coordinator's decision of 15 Nov 2026, option A: main's
 * design from the review of #4027). The email still goes, says the spend was not read, and shows no ad figure: no $0,
 * no return on ads and no cost per sale, nor the typed line as if it were all of the spend. The week is sent and kept
 * claimed, never counted failed and never read as a week with no ad spend. Synthetic store and stand-in sender.
 */
import { NextRequest } from "next/server";
import { GET as weekly } from "@/app/api/cron/weekly/route";
import { addSpend } from "@/lib/ad-spend";
import { control, texts } from "./weekly-spend-unread-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "st-fixture";
const today = new Date().toISOString().slice(0, 10);
const request = () => new NextRequest("https://example.test/api/cron/weekly");
const real = redis.pipeline.bind(redis);
let metaUnread = false;
const commands: (string | number)[][] = [];

async function main(): Promise<void> {
  globalThis.fetch = async () => { throw new Error("No real network request belongs in this test"); };
  redis.pipeline = (async (batch: (string | number)[][]) => {
    commands.push(...batch.map((c) => [...c]));
    return metaUnread && batch[0]?.[0] === "EXISTS" && String(batch[0][1]).startsWith("nl:metaads:conn:") ? [] : real(batch);
  }) as typeof redis.pipeline;
  /** Whether this run took the week's claim (SET … NX on nl:weekly:sent:) and still holds it. */
  const claimed = () => {
    const set = commands.find((c) => c[0] === "SET" && String(c[1]).startsWith("nl:weekly:sent:") && c.includes("NX"));
    return Boolean(set) && redis.run(["GET", String(set![1])]) !== null;
  };
  const reset = async (unread: boolean) => {
    redis.clear();
    control.sent.length = 0;
    texts.length = 0;
    control.numbers = "visitors-5";
    // A typed line of $12, so a Meta part unread could be mistaken for all of the spend.
    await addSpend(STATS, { channel: "instagram", campaign: "", cents: 1200, from: today, to: today });
    metaUnread = unread;
    commands.length = 0;
  };

  part("The Meta part of the spend could not be read");
  await reset(true);
  const body = await (await weekly(request())).json();
  const text = texts[0] ?? "";
  is("the email still goes: sent, nothing failed", [body.ok, body.sent, body.failed, control.sent.length], [true, 1, 0, 1]);
  is("it says the spend was not read", text.includes("Ad spend could not be read"), true);
  is("no ad figure at all: no $12 as if it were all, no $0", [text.includes("$12"), text.includes("$0")], [false, false]);
  is("no return on ads and no cost per sale", [/return on ad|ROAS/i.test(text), /cost per (sale|order)/i.test(text)], [false, false]);
  is("the week stays claimed (sent), never let go as failed", claimed(), true);

  part("Control: every part read");
  await reset(false);
  await weekly(request());
  is("nothing says the spend was not read, and the week is sent", [(texts[0] ?? "").includes("Ad spend could not be read"), control.sent.length, claimed()], [false, 1, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
