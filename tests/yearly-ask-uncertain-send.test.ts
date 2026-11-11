/**
 * CX-123 rule 24 (Claude 6 audit, round 6, finding 3): the yearly offer goes once per membership, ever. sendEmail
 * answers false both when the email was refused and when it is not known (Amazon SES or Resend may have taken it and
 * the reply been lost), so false keeps the mark, as lib/trial-nudges.ts does: the member is never written to twice.
 * The mark is let go only when nothing was handed to the sender (the run failed before it).
 */
import { askStore } from "@/lib/yearly-ask";
import { NOW, owner, reset, world } from "./yearly-ask-uncertain-world";
import { done, is, part } from "./check";

const MARK = `nl:yearask:${"b".repeat(32)}:sub_SyntheticYearlyU`;
async function run(): Promise<number> {
  try { return await askStore(owner, Date.now() + 20_000, NOW); } catch { return -1; }
}

async function main(): Promise<void> {
  part("Healthy control: sent once, and never again");
  reset();
  is("the first run sends the offer", [await run(), world.mails, world.marks.has(MARK)], [1, 1, true]);
  is("the next run sends nothing", [await run(), world.mails], [0, 1]);

  part("sendEmail answered false (refused or not known): the mark stays, and the next run does not write again");
  reset();
  world.mail = () => Promise.resolve(false);
  is("the first run hands the offer to the sender once and counts it as not sent", [await run(), world.mails], [0, 1]);
  is("the mark is kept", world.marks.has(MARK), true);
  world.mail = () => Promise.resolve(true);
  is("the next run does not send the offer a second time", [await run(), world.mails], [0, 1]);

  part("sendEmail threw (not known whether it went): the mark stays, and the next run does not write again");
  reset();
  world.mail = () => Promise.reject(new Error("synthetic: the connection dropped after the request went out"));
  await run();
  is("the offer was handed to the sender once", world.mails, 1);
  is("the mark is kept", world.marks.has(MARK), true);
  world.mail = () => Promise.resolve(true);
  is("the next run does not send the offer a second time", [await run(), world.mails], [0, 1]);

  part("Confirmed not sent (the run failed before the sender): the mark is let go, and the next run sends once");
  reset();
  world.mintFails = true;
  await run();
  is("nothing was handed to the sender", [world.mints, world.mails], [1, 0]);
  is("the mark is let go", world.marks.has(MARK), false);
  world.mintFails = false;
  is("the next run sends the offer once", [await run(), world.mails], [1, 1]);
  is("and never twice", [await run(), world.mails], [0, 1]);
  done();
}
void main().catch((error) => { console.error(error); process.exit(1); });
