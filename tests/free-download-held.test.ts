/**
 * MM-SA-39 (route security audit, third pass; 506 [SG1]): a free copy's emailed link lives seven days, and
 * POST /api/store/free/download looked the product up again but only asked whether it was still there and still free.
 * A product the creator has since put back to draft (hidden), or a store switched off after notices about its content
 * (suspended, lib/takedown.ts), still handed over its file or link, and still added the address to the creator's list.
 * Now both are refused with the same 410 as a product that is gone, before the address joins the list.
 *
 * Synthetic only: the in-memory Redis stand-in, a claim written as lib/free.ts writes it, no email sent.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as download } from "@/app/api/store/free/download/route";
import { leadsKey } from "@/lib/contacts";
import { addProduct, claimHandle, ensureListId, ensureStatsId, noteTakedown, setProductHidden, setProductLink, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const claimKeyOf = (token: string) => `nl:free:claim:${sha(`nimbus-free-claim:${token}`).slice(0, 40)}`;
let serial = 0;

async function main() {
  redis.clear();
  const OWNER = "heron@example.com";
  await claimHandle(OWNER, "heronstudio", "Heron Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const made = await addProduct(OWNER, "Starter guide", "A synthetic free guide", "0");
  if (!made.ok) throw new Error(`synthetic product not made: ${JSON.stringify(made)}`);
  const productId = made.product.id;
  const linked = await setProductLink(OWNER, productId, "https://example.com/starter-guide");
  if (!linked.ok) throw new Error(`synthetic link not set: ${JSON.stringify(linked)}`);
  const listId = (await storeForEmail(OWNER))!.listId as string;

  /** A fresh link for `email`, written as lib/free.ts writes a claim, then its button pressed. */
  const press = async (email: string) => {
    const token = (serial++).toString(16).padStart(64, "0");
    await redis.pipeline([["SET", claimKeyOf(token), JSON.stringify({ h: "heronstudio", p: productId, e: email, c: true, at: new Date().toISOString() }), "EX", 7 * 86_400]]);
    const form = new FormData();
    form.set("token", token);
    const response = await download(new NextRequest("https://marktmorgen.com/api/store/free/download", { method: "POST", body: form }));
    const [row] = (await redis.pipeline([["HGET", leadsKey(listId), email]])) as [unknown];
    return { status: response.status, location: response.headers.get("location"), listed: typeof row === "string" };
  };

  part("Control: a published free product in a store that is open hands its link over");
  const open = await press("ana@example.com");
  is("the link is handed over", [open.status, open.location], [303, "https://example.com/starter-guide"]);
  is("and the address joins the creator's list", open.listed, true);

  part("A product put back to draft since the email: nothing is handed over, nobody is added");
  await setProductHidden(OWNER, productId, true);
  const draft = await press("bea@example.com");
  is("refused as gone (410), with no link", [draft.status, draft.location], [410, null]);
  is("the address does not join the list", draft.listed, false);
  await setProductHidden(OWNER, productId, false);

  part("A store switched off after notices about its content: nothing is handed over, nobody is added");
  await noteTakedown(OWNER, null, true);
  const suspended = await press("cal@example.com");
  is("refused as gone (410), with no link", [suspended.status, suspended.location], [410, null]);
  is("the address does not join the list", suspended.listed, false);
  await noteTakedown(OWNER, null, false);

  part("Control again: published and open, it works as before");
  const again = await press("dee@example.com");
  is("the link is handed over", [again.status, again.location], [303, "https://example.com/starter-guide"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
