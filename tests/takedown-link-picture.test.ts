/**
 * A link taken down by a notice deletes its picture, or hands it to the daily
 * job that deletes files nobody keeps (sweepTaskUploads, app/api/cron/courses),
 * as a deleted person's files are (lib/person-erasure.ts). The creator's
 * notice says "The link and its file are deleted": before, a delete the file
 * store failed was swallowed, the notice still went out, and the picture
 * stayed with nothing left pointing at it. Synthetic data only.
 */
import { addStoreLink, claimHandle, ensureStatsId, setLinkImage, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport, takeDown } from "@/lib/takedown";
import { blobDown, deleted, files } from "./takedown-link-picture-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[] | string; subject: string; text: string };
const sent: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const NOTICE = {
  kind: "copyright",
  url: "https://marktmorgen.com/@picturenotice",
  work: "My photograph 'Harbor at dawn', used as this link's picture without my permission.",
  original: "https://example.com/harbor-at-dawn",
  name: "Rita Owner",
  email: "rita@example.com",
  contact: "+1 555 0100",
  signature: "Rita Owner",
  goodFaith: true,
  accurate: true,
};
const DOORS_KEY = "nl:tasks:doors";

async function linkWithPicture(owner: string, path: string): Promise<string> {
  const link = await addStoreLink(owner, "My mixtape", "https://soundcloud.com/someone/a-track");
  if (!link.ok) throw new Error("setup");
  const id = link.store.links[link.store.links.length - 1].id;
  files.set(path, true);
  const pictured = await setLinkImage(owner, id, { path, width: 320, height: 320, bytes: 3 });
  if (!pictured.ok) throw new Error("setup picture");
  return id;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";
  const owner = "picturenotice@example.com";
  await claimHandle(owner, "picturenotice", "Picture Notice", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestPicture001", true);
  await setSubscription(owner, { customerId: "cus_Picture001", subscriptionId: "sub_Picture001", active: true, period: paidPeriod() });
  const read = readReport(NOTICE);
  if (!read.ok) throw new Error("notice");
  is("the notice is sent", await fileReport(read.report, "9.9.9.9", "https://marktmorgen.com"), "sent");
  const token = sent[0].text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  const report = (await openReport(token))!.report;
  const store = () => storeForEmail(owner).then((s) => s!);

  part("A picture the file store deletes is gone at once");
  const first = `images/${"a".repeat(24)}/${"b".repeat(32)}.webp`;
  const one = await linkWithPicture(owner, first);
  is("the link is taken down", typeof (await takeDown(report, await store(), { type: "link", id: one }, "https://marktmorgen.com")), "string");
  is("its picture is deleted", [files.has(first), deleted.includes(first)], [false, true]);
  is("nothing is left for the daily job", redis.run(["ZSCORE", DOORS_KEY, first]), null);

  part("A picture whose delete fails is handed to the daily job, never left behind");
  const second = `images/${"c".repeat(24)}/${"d".repeat(32)}.webp`;
  const two = await linkWithPicture(owner, second);
  blobDown.on = true;
  sent.length = 0;
  const said = await takeDown(report, await store(), { type: "link", id: two }, "https://marktmorgen.com");
  blobDown.on = false;
  is("the link is still taken down", typeof said, "string");
  is("the file is still there, for now", files.has(second), true);
  is("it is listed for the daily job that deletes files nobody keeps, already past its day", redis.run(["ZSCORE", DOORS_KEY, second]), "0");
  done();
}

void main();
