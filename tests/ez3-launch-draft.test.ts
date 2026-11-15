/**
 * 366 [EZ3], unit 1: when a creator publishes a paid product, a launch email
 * waits as a draft in the studio (lib/mail-drafts.ts), built from the
 * product's own public title, summary, price and address, with no AI, for
 * everyone who has not bought it. Never sent on its own: the owner or an
 * Admin reads it and sends it, or not.
 *
 * What fails here:
 *   - a draft for a free product, a product still hidden, or a store with no list;
 *   - a second draft for the same product (republished, retried);
 *   - an unconfirmed claim treated as a free one;
 *   - a draft saved over one already there, or past the store's twenty;
 *   - the audience anything but "everyone who has not bought it";
 *   - words the product does not have (a discount, urgency, a count), or AI.
 */
import { readFileSync } from "node:fs";
import { keepLaunchDraft, launchDraftText, launchMark } from "@/lib/launch-draft";
import { listDraftsStrict, MAX_DRAFTS, saveDraft } from "@/lib/mail-drafts";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const product = { id: "prodlaunch01", title: "Glazes 201", summary: "Twelve recipes for stoneware glazes.", priceCents: 2900, hidden: false, options: [], recurring: null, pwyw: null, call: null } as unknown as Listing;
const store = { name: "Kiln Works", handle: "kiln", language: "en", currency: "usd", listId: "launchlist", catalog: { items: [{ id: "prodlaunch01" }, { id: "prodfree0001" }] } } as unknown as Store;

async function main(): Promise<void> {
  part("What the draft says");
  const text = launchDraftText(store, product, "https://marktmorgen.com/@kiln/p/glazes-201");
  is("the product's own title in the subject", text.subject, "New from Kiln Works: Glazes 201");
  is("its summary, its price and its address", ["Twelve recipes for stoneware glazes.", "$29", "https://marktmorgen.com/@kiln/p/glazes-201"].every((v) => text.body.includes(v)), true);
  is("nothing the product does not say", /% off|discount|hurry|today only|last chance|limited|\d+ (people|buyers)/i.test(`${text.subject} ${text.body}`), false);
  is("no AI anywhere", /from "@\/lib\/ai|assistant|model/.test(readFileSync("lib/launch-draft.ts", "utf8")), false);

  part("Once, for a paid product made public");
  redis.clear();
  is("a paid product published: a draft", await keepLaunchDraft(store, product, "https://x/p"), "saved");
  const drafts = await listDraftsStrict(store.listId);
  is("one draft, for everyone who has not bought it", [drafts.length, drafts[0]?.audience], [1, { who: "all", notProductId: "prodlaunch01", narrow: null }]);
  is("published again: no second draft", [await keepLaunchDraft(store, product, "https://x/p"), (await listDraftsStrict(store.listId)).length], ["already", 1]);
  is("the mark is the product's on this list", (await redis.pipeline([["EXISTS", launchMark("launchlist", "prodlaunch01")]]))[0], 1);
  is("a free product: none", await keepLaunchDraft(store, { ...product, id: "prodfree0001", priceCents: 0 } as Listing, "https://x/p"), "skipped");
  is("still hidden: none", await keepLaunchDraft(store, { ...product, hidden: true } as Listing, "https://x/p"), "skipped");
  is("no list: none", await keepLaunchDraft({ ...store, listId: null } as unknown as Store, product, "https://x/p"), "skipped");

  part("Never over the store's own drafts");
  redis.clear();
  for (let i = 0; i < MAX_DRAFTS; i += 1) await saveDraft(store, "owner@example.com", { subject: `Mine ${i}`, body: "Mine", productId: "" });
  is("twenty already: none added, nothing replaced, the mark let go", [await keepLaunchDraft(store, product, "https://x/p"), (await listDraftsStrict(store.listId)).filter((d) => d.subject.startsWith("Mine")).length, (await redis.pipeline([["EXISTS", launchMark("launchlist", "prodlaunch01")]]))[0]], ["full", MAX_DRAFTS, 0]);

  part("An unconfirmed claim is never taken as free");
  redis.clear();
  const original = redis.pipeline;
  redis.pipeline = async (commands) => (commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:launch:") ? ["QUEUED"] : original.call(redis, commands));
  let outcome: unknown;
  try { outcome = await keepLaunchDraft(store, product, "https://x/p"); } catch { outcome = "unknown"; }
  redis.pipeline = original;
  is("unknown, and no draft", [outcome, (await listDraftsStrict(store.listId)).length], ["unknown", 0]);

  part("Called only after a publish that went through");
  const route = readFileSync("app/api/store/product/route.ts", "utf8");
  is("the product route keeps a draft when a product becomes public", /if \(done\.ok && body\.hidden === false && done\.product\) await keepLaunchDraftQuietly\(done\.store, done\.product\);/.test(route), true);
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
