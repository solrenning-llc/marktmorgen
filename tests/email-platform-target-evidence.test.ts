/** A successful HTTP status is not proof of an empty destination list. */
import { EMAIL_PROVIDERS, MAX_TARGETS, PlatformError, listTargets, type EmailProvider } from "@/lib/email-platforms";
import { connect } from "@/lib/email-sync";
import { claimHandle, ensureStatsId, setEmailSyncRef, storeForEmail } from "@/lib/store";
import { seal } from "@/lib/secret-box";
import { answerWith, requests } from "./email-platform-target-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const keyFor = (provider: EmailProvider) => provider === "mailchimp" ? `${"a".repeat(32)}-us21` : "synthetic-platform-target-key";
const fieldFor = (provider: EmailProvider) => provider === "mailchimp" ? "lists" : provider === "kit" ? "forms" : "data";
const page = (provider: EmailProvider, rows: unknown) => JSON.stringify({ [fieldFor(provider)]: rows });

async function result(provider: EmailProvider, body: string, status = 200): Promise<unknown> {
  answerWith({ body, status });
  try { return await listTargets(provider, keyFor(provider)); }
  catch (error) { return error instanceof PlatformError ? [error.kind, error.status, error.retry] : "unexpected error"; }
}

async function main(): Promise<void> {
  part("Every provider needs a confirmed envelope and every destination");
  for (const provider of EMAIL_PROVIDERS) {
    const malformed = ["", "{", "null", "[]", "{}", page(provider, null), page(provider, {}), page(provider, "empty")];
    for (const body of malformed) is(`${provider}: malformed envelope ${body}`, await result(provider, body), ["server", 200, true]);
    const invalidRows = [null, [], "target", 7, {}, { id: "" }, { id: {} }, { id: "wrong/path" }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }];
    for (const row of invalidRows) {
      is(`${provider}: no partial page after invalid row ${JSON.stringify(row)}`, await result(provider, page(provider, [{ id: "chosen", name: "Saved audience" }, row])), ["server", 200, true]);
    }
    is(`${provider}: explicit empty list remains valid`, await result(provider, page(provider, [])), []);
    is(`${provider}: existing names, numeric ids and fallback names`, await result(provider, page(provider, [{ id: "chosen", name: "  Saved\n audience " }, { id: 42 }, { id: "third", name: 7 }])), [{ id: "chosen", name: "Saved audience" }, { id: "42", name: "42" }, { id: "third", name: "third" }]);
    is(`${provider}: exactly one bounded GET, no new request`, requests.map(({ options }) => [options.method, options.maxBytes, options.maxRedirects, options.timeoutMs <= 8000, options.body]), [["GET", 1000000, 0, true, undefined]]);
    const many = Array.from({ length: MAX_TARGETS + 1 }, (_, n) => ({ id: String(n), name: `Target ${n}` }));
    const targets = await result(provider, page(provider, many));
    is(`${provider}: existing cap and order retained`, Array.isArray(targets) ? [targets.length, targets[0], targets[MAX_TARGETS - 1]] : targets, [MAX_TARGETS, { id: "0", name: "Target 0" }, { id: String(MAX_TARGETS - 1), name: `Target ${MAX_TARGETS - 1}` }]);
    is(`${provider}: invalid evidence past picker cap still refuses page`, await result(provider, page(provider, [...many, null])), ["server", 200, true]);
    is(`${provider}: refused key retains existing classification`, await result(provider, "{}", 401), ["key", 401, true]);
    is(`${provider}: server failure retains existing classification`, await result(provider, "{}", 503), ["server", 503, true]);
  }

  part("Real reconnect must preserve confirmed settings after a malformed list");
  redis.clear();
  const owner = "platform-target-evidence@example.test";
  await claimHandle(owner, "targetevidence", "Synthetic target evidence", "");
  await ensureStatsId(owner);
  await setEmailSyncRef(owner, { buyers: "all", products: [] });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  const configKey = `nl:esync:cfg:${statsId}`;
  const tagsKey = `nl:esync:tags:${statsId}`;
  const badKey = `nl:esync:bad:${statsId}`;
  const config = JSON.stringify({ handle: store.handle, provider: "kit", key: seal(keyFor("kit"), `email-sync|${statsId}|kit`), last4: "-key", target: { id: "chosen", name: "Saved audience" }, free: true, buyers: "all", products: [], tags: {}, since: 1, connectedAt: 2 });
  for (const body of ["{}", page("kit", [{ id: "chosen" }, null])]) {
    await setEmailSyncRef(owner, { buyers: "all", products: [] });
    await redis.pipeline([["SET", configKey, config], ["HSET", tagsKey, "kit|saved", "tag-id"], ["SET", badKey, "retained problem"]]);
    const before = await redis.pipeline([["GET", configKey], ["HGET", tagsKey, "kit|saved"], ["GET", badKey]]);
    answerWith({ body: "{}" }, { body });
    const connected = await connect(store, "kit", keyFor("kit"), 300);
    is("malformed reconnect reports failure", connected.ok, false);
    is("malformed reconnect preserves sealed settings and cached state byte for byte", await redis.pipeline([["GET", configKey], ["HGET", tagsKey, "kit|saved"], ["GET", badKey]]), before);
    is("malformed reconnect preserves real store buyer-consent reference", (await storeForEmail(owner))?.emailSync, store.emailSync);
    is("only existing ping and target GETs, no POST or retry", requests.map(({ options }) => options.method), ["GET", "GET"]);
  }
  answerWith({ body: "{}" }, { body: page("kit", [{ id: "chosen", name: "Saved audience" }]) });
  const connected = await connect(store, "kit", keyFor("kit"), 301);
  is("confirmed reconnect still succeeds and retains selection", connected.ok ? connected.view.connected?.target : connected, { id: "chosen", name: "Saved audience" });
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
