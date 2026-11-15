/**
 * 361 [AP1] (e), unit 2: the reminder the day before a member's access ends,
 * sent (lib/access-ending.ts endingStore), against a memory Redis, a stubbed
 * Stripe and a stubbed mailer (tests/ap1-e-ending-world.ts). No real email.
 *
 * What fails here:
 *   - anything sent while the creator's switch is off;
 *   - a reminder to somebody who did not agree or has left the list;
 *   - a reminder for a membership not due (more than a day away, no end);
 *   - a reminder sent without reading the membership again just before, or
 *     sent when that read fails, or when it says the end moved or went away;
 *   - two reminders for one end; a send that failed keeping its mark;
 *   - the email without the real end, the way to keep it, the creator's
 *     postal address, or charged anywhere but the store's own email quota.
 */
import { endingStore } from "@/lib/access-ending";
import type { Store } from "@/lib/store";
import { failSends, fresh, mails, memory, reset } from "./ap1-e-ending-world";
import { done, is, part } from "./check";

const now = Date.parse("2026-11-15T12:00:00Z");
const H = 3_600_000;
const soon = Math.floor((now + 20 * H) / 1000);
const later = Math.floor((now + 50 * H) / 1000);
const store = {
  name: "Kiln Works", handle: "kiln", email: "kiln@example.com", language: "en",
  stripeAccountId: "acct_1TestKiln000001", statsId: "statskiln", listId: "listkiln",
  ending: { on: true, address: "1 Synthetic Street, Testville" },
} as unknown as Store;
const sub = (id: string, email: string, cancelAt: number | null, status = "active") => ({ id, status, cancel_at: cancelAt, customer: { email }, metadata: { store: "kiln" } });
const run = (rows: unknown[], s: Store = store) => endingStore(s, rows as never, Date.now() + 60_000, now);

async function main(): Promise<void> {
  part("Off unless the creator turned it on");
  reset();
  is("off: nothing read or sent", [await run([sub("sub_A1", "ana@example.com", soon)], { ...store, ending: { on: false, address: "" } } as Store), mails.length], [0, 0]);

  part("Only the due, only the agreed, read again before sending");
  reset();
  fresh.set("sub_A1", sub("sub_A1", "ana@example.com", soon));
  fresh.set("sub_B2", sub("sub_B2", "ben@example.com", later));
  fresh.set("sub_C3", sub("sub_C3", "left@example.com", soon));
  const rows = [sub("sub_A1", "ana@example.com", soon), sub("sub_B2", "ben@example.com", later), sub("sub_C3", "left@example.com", soon), sub("sub_D4", "dan@example.com", null)];
  is("one sent: the agreed member whose end is within a day", [await run(rows), mails.map((m) => m.to)], [1, ["ana@example.com"]]);
  const mail = mails[0];
  is("it names the real end, not a number of hours", mail.subject.includes("November 16, 2026") && !/24/.test(mail.subject), true);
  is("it says how to keep it, with the member page", mail.text.includes("https://marktmorgen.com/@kiln/manage"), true);
  is("it carries the creator's postal address", mail.text.includes("1 Synthetic Street, Testville"), true);
  is("it is counted in the store's own email quota", JSON.stringify(mail.meter), JSON.stringify({ by: "store", store, kind: "email" }));
  is("its mark is kept for that end", (await memory.pipeline([["EXISTS", `nl:ending:statskiln:sub_A1:${soon}`]]))[0], 1);
  is("a second run sends nothing more for the same end", [await run(rows), mails.length], [0, 1]);

  part("The membership read again decides");
  reset();
  fresh.set("sub_A1", sub("sub_A1", "ana@example.com", null));
  is("the end went away (they changed their mind): nothing sent, mark let go", [await run([sub("sub_A1", "ana@example.com", soon)]), mails.length, (await memory.pipeline([["EXISTS", `nl:ending:statskiln:sub_A1:${soon}`]]))[0]], [0, 0, 0]);
  reset();
  fresh.set("sub_A1", sub("sub_A1", "ana@example.com", later));
  is("the end moved: nothing sent now", [await run([sub("sub_A1", "ana@example.com", soon)]), mails.length], [0, 0]);
  reset();
  is("the read fails: nothing sent, mark let go", [await run([sub("sub_A1", "ana@example.com", soon)]), mails.length, (await memory.pipeline([["EXISTS", `nl:ending:statskiln:sub_A1:${soon}`]]))[0]], [0, 0, 0]);
  reset();
  fresh.set("sub_A1", sub("sub_A1", "ana@example.com", soon, "canceled"));
  is("no longer running: nothing sent", [await run([sub("sub_A1", "ana@example.com", soon)]), mails.length], [0, 0]);

  part("A send that fails lets its mark go, so the next run can try");
  reset();
  fresh.set("sub_A1", sub("sub_A1", "ana@example.com", soon));
  failSends();
  is("nothing counted as sent, mark let go", [await run([sub("sub_A1", "ana@example.com", soon)]), (await memory.pipeline([["EXISTS", `nl:ending:statskiln:sub_A1:${soon}`]]))[0]], [0, 0]);
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
