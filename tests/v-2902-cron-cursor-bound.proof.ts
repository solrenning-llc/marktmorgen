/**
 * Review proof for #2902: a syntactically valid cursor must still name a
 * position in the current folder list. A very large whole number is unknown,
 * not proof that every store was already visited today.
 */
import { GET as quiet } from "@/app/api/cron/quiet/route";
import { rememberFolderOwner } from "@/lib/delivery";
import { store as redis } from "./redis-stub";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
delete process.env.CRON_SECRET;
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ object: "list", data: [], has_more: false }), {
    status: 200,
  })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const email = "cursor-bound@example.com";
  await claimHandle(email, "cursor-bound", "Cursor Bound", "");
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  await rememberFolderOwner(folder, email);

  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const cursor = `nl:quiet:at:${now.toISOString().slice(0, 10)}`;
  await redis.pipeline([
    ["SADD", `nl:traffic:folders:${month}`, folder],
    ["SET", cursor, "999999999"],
  ]);

  part("Quiet cron cursor is bounded by the folders read for this pass");
  const response = await quiet({
    headers: new Headers(),
    nextUrl: new URL("https://marktmorgen.com/api/cron/quiet"),
  } as unknown as Parameters<typeof quiet>[0]);
  const [kept] = await redis.pipeline([["GET", cursor]]);
  is("an out-of-range whole-number cursor is unknown", response.status, 503);
  is("the unknown cursor is not rewritten as a completed pass", kept, "999999999");
  done();
}

void main();
