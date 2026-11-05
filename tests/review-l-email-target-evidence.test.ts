import { EMAIL_PROVIDERS, PlatformError, listTargets, type EmailProvider } from "@/lib/email-platforms";
import { connect } from "@/lib/email-sync";
import { claimHandle, ensureStatsId, setEmailSyncRef, storeForEmail } from "@/lib/store";
import { seal } from "@/lib/secret-box";
import { answerWith, requests } from "./email-platform-target-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const keyFor = (p: EmailProvider) => p === "mailchimp" ? `${"a".repeat(32)}-us21` : "synthetic-review-target-key";
const field = (p: EmailProvider) => p === "mailchimp" ? "lists" : p === "kit" ? "forms" : "data";
const body = (p: EmailProvider, rows: unknown) => JSON.stringify({ [field(p)]: rows });

async function main() {
  part("The parsed network response, including late invalid rows, is all or nothing");
  for (const provider of EMAIL_PROVIDERS) {
    for (const id of ["a/b", "a\nb", "a".repeat(65), "é", null, true, Number.MAX_SAFE_INTEGER + 2]) {
      answerWith({ body: body(provider, [{ id: "kept", name: "Kept" }, { id }]) });
      let kind = "accepted";
      try { await listTargets(provider, keyFor(provider)); } catch (e) { kind = e instanceof PlatformError ? e.kind : "unexpected"; }
      is(`${provider} rejects ${JSON.stringify(id)} without a second request`, [kind, requests.length], ["server", 1]);
    }
    answerWith({ body: body(provider, [{ id: "a".repeat(64), name: " x\n y " }, { id: Number.MAX_SAFE_INTEGER }]) });
    is(`${provider} keeps legal boundary ids and normalizes the display only`, await listTargets(provider, keyFor(provider)), [{ id: "a".repeat(64), name: "x y" }, { id: String(Number.MAX_SAFE_INTEGER), name: String(Number.MAX_SAFE_INTEGER) }]);
  }

  part("Every provider preserves saved consent and settings on unknown reconnect");
  redis.clear();
  const owner = "l-target-review@example.test";
  await claimHandle(owner, "ltargetreview", "Synthetic review", "");
  await ensureStatsId(owner);
  for (const provider of EMAIL_PROVIDERS) {
    await setEmailSyncRef(owner, { buyers: "all", products: [] });
    const store = (await storeForEmail(owner))!;
    const stats = store.statsId!;
    const cfg = `nl:esync:cfg:${stats}`;
    const tags = `nl:esync:tags:${stats}`;
    const bad = `nl:esync:bad:${stats}`;
    const value = JSON.stringify({ handle: store.handle, provider, key: seal(keyFor(provider), `email-sync|${stats}|${provider}`), last4: "test", target: { id: "kept", name: "Kept" }, free: true, buyers: "all", products: [], tags: {}, since: 1, connectedAt: 2 });
    await redis.pipeline([["SET", cfg, value], ["HSET", tags, "saved", "tag"], ["SET", bad, "retained"]]);
    const before = await redis.pipeline([["GET", cfg], ["HGET", tags, "saved"], ["GET", bad]]);
    answerWith({ body: "{}" }, { body: body(provider, [{ id: "kept" }, null]) });
    const result = await connect(store, provider, keyFor(provider));
    is(`${provider} reports unknown evidence`, result.ok, false);
    is(`${provider} preserves bytes`, await redis.pipeline([["GET", cfg], ["HGET", tags, "saved"], ["GET", bad]]), before);
    is(`${provider} preserves consent reference`, (await storeForEmail(owner))?.emailSync, store.emailSync);
    is(`${provider} uses only ping and list`, requests.map(x => x.options.method), ["GET", "GET"]);
  }
  done();
}
void main();
