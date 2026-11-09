/** A successful HTTP status is not proof of an empty destination list. */
import { EMAIL_PROVIDERS, MAX_TARGETS, PlatformError, listTargets, type EmailProvider } from "@/lib/email-platforms";
import { connect, testConnection, saveSettings, refreshTargets } from "@/lib/email-sync";
import { claimHandle, ensureStatsId, setEmailSyncRef, storeForEmail } from "@/lib/store";
import { seal } from "@/lib/secret-box";
import { answerWith, requests } from "./email-platform-target-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const keyFor = (provider: EmailProvider) => provider === "mailchimp" ? `${"a".repeat(32)}-us21` : "synthetic-platform-target-key";
const fieldFor = (provider: EmailProvider) => provider === "mailchimp" ? "lists" : provider === "kit" ? "forms" : "data";
// Terminal-page fixtures follow the four providers' documented pagination.
function terminal(provider: EmailProvider, count: number): Record<string, unknown> {
  switch (provider) {
    case "mailchimp": return { total_items: count };
    case "kit": return { pagination: { has_previous_page: false, has_next_page: false } };
    case "beehiiv": return { page: 1, total_pages: count ? 1 : 0, total_results: count };
    case "mailerlite": return { links: { prev: null, next: null }, meta: { current_page: 1, last_page: 1, total: count } };
  }
}
const page = (provider: EmailProvider, rows: unknown, metadata = terminal(provider, Array.isArray(rows) ? rows.length : 0)) => JSON.stringify({ [fieldFor(provider)]: rows, ...metadata });

function incomplete(provider: EmailProvider, count: number): Record<string, unknown>[] {
  switch (provider) {
    case "mailchimp": return [{}, { total_items: count + 1 }, { total_items: String(count) }, { total_items: -1 }, { total_items: count + 0.5 }];
    case "kit": return [{}, { pagination: null }, { pagination: { has_previous_page: false, has_next_page: true } }, { pagination: { has_previous_page: true, has_next_page: false } }, { pagination: { has_previous_page: false, has_next_page: "false" } }];
    case "beehiiv": return [{}, { page: 1, total_pages: 2, total_results: count + 1 }, { page: 2, total_pages: 2, total_results: count }, { page: 1, total_pages: 1, total_results: String(count) }, { page: 1, total_pages: 1, total_results: count + 1 }];
    case "mailerlite": return [{}, { links: { prev: null, next: "https://connect.mailerlite.com/api/groups?page=2" }, meta: { current_page: 1, last_page: 2, total: count + 1 } }, { links: { prev: null, next: null }, meta: { current_page: 1, last_page: 2, total: count } }, { links: { prev: null, next: null }, meta: { current_page: 2, last_page: 2, total: count } }, { links: { prev: null, next: null }, meta: { current_page: 1, last_page: 1, total: count + 1 } }];
  }
}

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
    is(`${provider}: truncating a complete response would lose absence evidence`, await result(provider, page(provider, many)), ["server", 200, true]);
    const boundary = many.slice(0, MAX_TARGETS);
    is(`${provider}: a complete page at the unchanged cap retains order`, await result(provider, page(provider, boundary)), boundary);
    for (const metadata of incomplete(provider, 1)) {
      is(`${provider}: unconfirmed pagination refuses the whole page ${JSON.stringify(metadata)}`, await result(provider, page(provider, [{ id: "chosen" }], metadata)), ["server", 200, true]);
    }
    answerWith({ body: page(provider, [{ id: "wrong/path" }]) });
    let message = "";
    try { await listTargets(provider, keyFor(provider)); } catch (error) { message = error instanceof Error ? error.message : ""; }
    is(`${provider}: permanent malformed evidence makes no temporary promise`, /Nothing was changed/.test(message) && !/moment|again|contact us/i.test(message), true);
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
  part("C5 pagination: real callers never turn a first page into known absence");
  for (const provider of EMAIL_PROVIDERS) {
    const saved = JSON.stringify({ handle: store.handle, provider, key: seal(keyFor(provider), `email-sync|${statsId}|${provider}`), last4: "-key", target: { id: "chosen", name: "Saved audience" }, free: true, buyers: "all", products: [], tags: {}, since: 1, connectedAt: 2 });
    const rows = Array.from({ length: MAX_TARGETS }, (_, n) => ({ id: `page1_${n}`, name: `Target ${n}` }));
    // More than one page, absent metadata and malformed list are separate vectors.
    for (const body of [page(provider, rows, incomplete(provider, rows.length)[provider === "kit" ? 2 : 1]), page(provider, [], {}), "{}"]) {
      for (const action of ["connect", "testConnection", "saveSettings", "refreshTargets"] as const) {
        await setEmailSyncRef(owner, { buyers: "all", products: [] });
        await redis.pipeline([["SET", configKey, saved], ["HSET", tagsKey, "kit|saved", "tag-id"], ["SET", badKey, "retained problem"]]);
        const before = await redis.pipeline([["GET", configKey], ["HGET", tagsKey, "kit|saved"], ["GET", badKey]]);
        answerWith(...(action === "connect" || action === "testConnection" ? [{ body: "{}" }, { body }] : [{ body }]));
        const reply = action === "connect" ? await connect(store, provider, keyFor(provider), 302)
          : action === "testConnection" ? await testConnection(store)
          : action === "saveSettings" ? await saveSettings(store, { target: "other", free: true, buyers: "all", products: [], tags: {} })
          : await refreshTargets(store);
        is(`${provider}/${action}: partial or malformed evidence is unavailable`, reply.ok, false);
        is(`${provider}/${action}: no false absence or temporary promise`, "message" in reply ? !/not there anymore|not in your .* anymore|moment/i.test(reply.message) : false, true);
        is(`${provider}/${action}: settings, tags and previous problem remain byte-identical`, await redis.pipeline([["GET", configKey], ["HGET", tagsKey, "kit|saved"], ["GET", badKey]]), before);
        is(`${provider}/${action}: real buyer-consent reference retained`, (await storeForEmail(owner))?.emailSync, store.emailSync);
        is(`${provider}/${action}: only existing bounded GETs, no new page, POST or retry`, requests.map(({ options }) => [options.method, options.maxBytes, options.maxRedirects, options.timeoutMs <= 8000]), Array.from({ length: action === "connect" || action === "testConnection" ? 2 : 1 }, () => ["GET", 1000000, 0, true]));
      }
    }
    await redis.pipeline([["SET", configKey, saved], ["DEL", badKey]]);
    answerWith({ body: "{}" }, { body: page(provider, [{ id: "chosen", name: "Saved audience" }]) });
    is(`${provider}: complete selected destination still tests successfully`, (await testConnection(store)).ok, true);
    answerWith({ body: "{}" }, { body: page(provider, []) });
    const gone = await testConnection(store);
    is(`${provider}: a complete empty account can prove known absence`, [gone.ok, /not there anymore/.test(gone.message)], [false, true]);
    answerWith({ body: page(provider, [{ id: "other", name: "Other audience" }]) });
    const changed = await saveSettings(store, { target: "other", free: true, buyers: "all", products: [], tags: {} });
    is(`${provider}: a complete page still allows a real destination change`, changed.ok ? changed.view.connected?.target : changed, { id: "other", name: "Other audience" });
  }
  part("C5 LOW A: a confirmed larger account is our one-page limitation, not a provider fault");
  for (const provider of EMAIL_PROVIDERS) {
    const rows = Array.from({ length: MAX_TARGETS }, (_, n) => ({ id: `known_${n}`, name: `Destination ${n}` }));
    const metadata: Record<string, unknown> = provider === "mailchimp" ? { total_items: 150 }
      : provider === "kit" ? { pagination: { has_previous_page: false, has_next_page: true } }
      : provider === "beehiiv" ? { page: 1, total_pages: 2, total_results: 150 }
      : { links: { prev: null, next: "https://connect.mailerlite.com/api/groups?page=2" }, meta: { current_page: 1, last_page: 2, total: 150 } };
    answerWith({ body: page(provider, rows, metadata) });
    let refusal: PlatformError | undefined;
    try { await listTargets(provider, keyFor(provider)); } catch (error) { if (error instanceof PlatformError) refusal = error; }
    is(`${provider}: known additional destinations are explained as our one-page limitation`, /your .*account.*more.*one page/i.test(refusal?.message ?? ""), true);
    is(`${provider}: the refusal explains an action and promises no change`, /fewer destinations/i.test(refusal?.message ?? "") && /Nothing was connected or changed/.test(refusal?.message ?? ""), true);
    is(`${provider}: a permanent one-page limitation does not request an automatic retry`, refusal?.retry, false);
    is(`${provider}: explaining the refusal adds no page or productive write`, requests.map(({ options }) => options.method), ["GET"]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
