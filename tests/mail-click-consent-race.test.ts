/**
 * A link use that already read consent must not put the person's click history back after that consent is withdrawn
 * (Codex G, G-20261120-2236-defeito-main-mail-click-consent.md): stopCounting runs right after noteClick's consent
 * read, and the click must be neither reported nor kept. Synthetic store, list and addresses; no provider.
 */
import { upsertContact, leadsKey, parseContact, tokensFor } from "@/lib/contacts";
import { claimHandle, ensureListId, storeForEmail } from "@/lib/store";
import { linkKeyOf, noteClick, rememberLinkKeys, stopCounting, usedLinkIn } from "@/lib/mail-clicks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

async function main(): Promise<void> {
  redis.clear();
  const owner = "g-click-race-owner@example.com";
  const email = "g-click-race-reader@example.com";
  await claimHandle(owner, "g-click-race", "G Click Race", "");
  await ensureListId(owner);
  const store = (await storeForEmail(owner))!;
  const list = store.listId as string;
  await upsertContact(list, email, { agreed: true, explicit: true, clicks: true, source: "free" }, ROOM);
  const token = (await tokensFor(list, [email], store.handle)).get(email)!;
  await rememberLinkKeys(list, [{ email, token }]);
  const key = linkKeyOf(token);
  const campaign = "s-0123456789abcdef-fedcba9876543210";

  const pipeline = redis.pipeline.bind(redis);
  let revoked = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await pipeline(commands);
    const readsConsent = !revoked && commands.some((command) =>
      command[0] === "HGET" && command[1] === leadsKey(list) && command[2] === email,
    );
    if (readsConsent) {
      revoked = true;
      await stopCounting(token);
    }
    return replies;
  }) as typeof redis.pipeline;

  part("Consent revoked after noteClick reads it");
  let noted = false;
  try {
    noted = await noteClick(key, campaign);
  } finally {
    redis.pipeline = pipeline;
  }
  const [raw] = await redis.pipeline([["HGET", leadsKey(list), email]]);
  is("the revocation happened and remains on the contact", [revoked, Boolean(parseContact(raw)?.clicks)], [true, false]);
  is("no click is reported or retained after revocation", [noted, (await usedLinkIn(list, campaign, [email])).has(email)], [false, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
