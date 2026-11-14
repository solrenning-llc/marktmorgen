/**
 * The run that sends a creator's own plan notices (queue 414 [KX1],
 * lib/billing-reminders.ts, sendReminders), against a stand-in Stripe and
 * mail provider, with synthetic subscriptions only. What is checked:
 *
 *   - a yearly notice due on its 30th day is sent once; a second run sends
 *     nothing;
 *   - a notice that was sent is never counted as missed later;
 *   - a notice never sent, found a day or less before the charge, is counted
 *     as missed once, and not sent;
 *   - a failed send is counted as failed, and if the charge then comes too
 *     close, it is counted as missed;
 *   - a claim is won only on a proven "OK" (lib/claim-mark.ts, CX-123 rule
 *     24): any other answer to the SET NX ([], [undefined], ["unconfirmed"],
 *     [0]) whose write is not read back sends nothing, counts nothing as
 *     missed, is counted as unknown, and the next run tries again; a proven
 *     nil is somebody else's claim, and a reply lost on a write that landed
 *     is read back as ours.
 */
import { sendReminders } from "@/lib/billing-reminders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_notice_run_only";
process.env.RESEND_API_KEY = "re_test_notice_run_only";

const NOW = 1_791_700_000;
const DAY = 86_400;
const TODAY = Math.floor(NOW / DAY) * DAY;
const emails: string[] = [];
let emailWorks = true;
let subscriptions: Record<string, unknown>[] = [];

function yearly(id: string, at: number): Record<string, unknown> {
  return {
    id,
    status: "active",
    created: at - 400 * DAY,
    customer: { email: `${id}@example.com` },
    items: {
      data: [
        {
          current_period_start: at - 365 * DAY,
          current_period_end: at,
          price: { lookup_key: "nimbus_labs_creator_year", unit_amount: 29000, recurring: { interval: "year" } },
        },
      ],
    },
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com" && method === "GET" && url.pathname === "/v1/subscriptions") {
    const status = url.searchParams.get("status");
    return new Response(JSON.stringify({ data: subscriptions.filter((s) => s.status === status), has_more: false }), { status: 200 });
  }
  if (url.hostname === "api.resend.com") {
    if (!emailWorks) return new Response(JSON.stringify({ message: "down" }), { status: 500 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push(Array.isArray(body.to) ? body.to[0] : body.to);
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main() {
  const charge = TODAY + 30 * DAY + 5 * 3600;

  part("sent once on the 30th day, never counted as missed");
  {
    subscriptions = [yearly("sub_noticerun01", charge)];
    const first = await sendReminders(NOW);
    is("the first run sends one notice, on time", [first.sent, first.late, first.missed], [1, 0, 0]);
    const again = await sendReminders(NOW + 3600);
    is("a second run sends nothing", [again.sent, again.missed], [0, 0]);
    const close = await sendReminders(charge - 12 * 3600);
    is("half a day before the charge it is not counted as missed", [close.sent, close.missed], [0, 0]);
    is("one email in all", emails.filter((to) => to.startsWith("sub_noticerun01")).length, 1);
  }

  part("never sent, found half a day before the charge");
  {
    const at = TODAY + 40 * DAY;
    subscriptions = [yearly("sub_noticerun02", at)];
    const missed = await sendReminders(at - 12 * 3600);
    is("counted as missed, not sent", [missed.sent, missed.missed], [0, 1]);
    const again = await sendReminders(at - 6 * 3600);
    is("counted once", again.missed, 0);
    is("no email", emails.some((to) => to.startsWith("sub_noticerun02")), false);
  }

  part("a failed send, then too close");
  {
    const at = TODAY + 50 * DAY + 5 * 3600;
    subscriptions = [yearly("sub_noticerun03", at)];
    emailWorks = false;
    const failed = await sendReminders(at - 30 * DAY);
    is("the send failed and is counted as failed", [failed.sent, failed.failed], [0, 1]);
    emailWorks = true;
    const missed = await sendReminders(at - 12 * 3600);
    is("half a day before the charge it is counted as missed", [missed.sent, missed.missed], [0, 1]);
  }

  // The claim's SET NX answered in a shape that proves nothing; every other command is the stand-in's own.
  // With `landed`, the write is made first and only its answer is lost.
  const original = redis.pipeline;
  async function withClaimReply<T>(reply: unknown[], run: () => Promise<T>, landed = false): Promise<T> {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const claim = commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:remind:") && commands[0].includes("NX");
      if (!claim) return original.call(redis, commands);
      if (landed) await original.call(redis, commands);
      return [...reply];
    }) as typeof redis.pipeline;
    try {
      return await run();
    } finally {
      redis.pipeline = original;
    }
  }
  const UNKNOWN_REPLIES: unknown[][] = [[], [undefined], ["unconfirmed"], [0]];
  const shown = (reply: unknown[]) => `[${reply.map((value) => (value === undefined ? "undefined" : JSON.stringify(value))).join(", ")}]`;

  part("an unknown answer to the missed-notice claim is not a missed notice");
  for (const [i, reply] of UNKNOWN_REPLIES.entries()) {
    const at = TODAY + (60 + i) * DAY + 5 * 3600;
    const id = `sub_noticeunk1${i}`;
    subscriptions = [yearly(id, at)];
    const odd = await withClaimReply(reply, () => sendReminders(at - 12 * 3600));
    is(`reply ${shown(reply)}: not counted as missed, counted as unknown, not sent`, [odd.missed, odd.unknown, odd.sent], [0, 1, 0]);
    const next = await sendReminders(at - 6 * 3600);
    is(`reply ${shown(reply)}: the next run claims it and counts it as missed once`, [next.missed, next.unknown], [1, 0]);
    is(`reply ${shown(reply)}: no email`, emails.some((to) => to.startsWith(id)), false);
  }

  part("an unknown answer to the send claim sends nothing");
  for (const [i, reply] of UNKNOWN_REPLIES.entries()) {
    const at = TODAY + 30 * DAY + (6 + i) * 3600;
    const id = `sub_noticeunk2${i}`;
    subscriptions = [yearly(id, at)];
    const odd = await withClaimReply(reply, () => sendReminders(NOW));
    is(`reply ${shown(reply)}: nothing sent, counted as unknown, not failed`, [odd.sent, odd.unknown, odd.failed, odd.missed], [0, 1, 0, 0]);
    is(`reply ${shown(reply)}: no email on the unknown claim`, emails.filter((to) => to.startsWith(id)).length, 0);
    const next = await sendReminders(NOW + 3600);
    is(`reply ${shown(reply)}: the next run sends it once`, [next.sent, next.unknown], [1, 0]);
    is(`reply ${shown(reply)}: one email in all`, emails.filter((to) => to.startsWith(id)).length, 1);
  }

  part("controls: a proven nil, and an answer lost on a write that landed");
  const controls: unknown[] = [];
  {
    const at = TODAY + 30 * DAY + 11 * 3600;
    subscriptions = [yearly("sub_noticenil01", at)];
    await redis.pipeline([["SET", `nl:remind:renewal:sub_noticenil01:${at}`, "someone-else", "EX", 60]]);
    const taken = await sendReminders(NOW);
    is("a proven nil (claimed elsewhere): nothing sent, nothing failed", [taken.sent, taken.failed], [0, 0]);
    controls.push(taken.unknown);
    is("and no email", emails.some((to) => to.startsWith("sub_noticenil01")), false);
  }
  {
    const at = TODAY + 30 * DAY + 12 * 3600;
    subscriptions = [yearly("sub_noticelost1", at)];
    const lost = await withClaimReply([undefined], () => sendReminders(NOW), true);
    is("an answer lost on a write that landed is read back as ours: sent once", lost.sent, 1);
    controls.push(lost.unknown);
    is("one email", emails.filter((to) => to.startsWith("sub_noticelost1")).length, 1);
  }
  {
    const at = TODAY + 70 * DAY + 5 * 3600;
    subscriptions = [yearly("sub_noticelost2", at)];
    const lost = await withClaimReply(["unconfirmed"], () => sendReminders(at - 12 * 3600), true);
    is("a missed-notice claim lost but landed is counted as missed once", lost.missed, 1);
    const again = await sendReminders(at - 6 * 3600);
    is("and not again", again.missed, 0);
    controls.push(lost.unknown, again.unknown);
  }
  is("none of the controls is counted as unknown", controls, [0, 0, 0, 0]);
  done();
}

main();
