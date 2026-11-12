import { readDraftAudience, sameDraftAudience } from "@/lib/mail-draft-audience";
import { DraftReadUnavailable, listDraftsStrict, parseDraftList, saveDraft } from "@/lib/mail-drafts";
import { confirmedDraftId } from "@/lib/mail-response";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
async function main() {
  redis.clear();
  const store = { listId: "draft-audience", catalog: { items: [{ id: "included" }, { id: "excluded" }] } } as unknown as Store;
  const key = "nl:mail:drafts:" + store.listId;
  const content = { subject: "Subject", body: "Content", productId: "included" };
  const filters = [null, { minSpent: 2550, channel: "newsletter", quietDays: 30 }, { minSpent: 100000000, channel: "", quietDays: 365 }];
  let savedId = "";
  let savedAudience: unknown;
  part("Save, reload and confirmation preserve the whole audience");
  for (const who of ["all", "buyers", "leads"]) for (const notProductId of [null, "excluded"]) for (const narrow of filters) {
    const audience = { who, notProductId, narrow };
    const saved = await saveDraft(store, "OWNER@example.com", { ...content, audience });
    is("save succeeds for an owned audience", saved.ok, true);
    if (!saved.ok) throw new Error("fixture could not save");
    savedId = saved.draft.id; savedAudience = audience;
    is("acknowledgement includes audience", saved.draft.audience, audience);
    const loaded = (await listDraftsStrict(store.listId)).find(d => d.id === savedId);
    is("fresh storage read restores the exact audience", loaded?.audience, audience);
    is("client confirms the expected audience", confirmedDraftId({ ok: true, draft: saved.draft }, savedId, audience), savedId);
    is("a different audience cannot confirm saving", confirmedDraftId({ ok: true, draft: saved.draft }, savedId, { ...audience, who: who === "all" ? "buyers" : "all" }), null);
  }
  part("Older clients preserve restrictions and new clients can clear them explicitly");
  const oldUpdate = await saveDraft(store, "owner@example.com", { ...content, id: savedId, body: "Updated by an older client" });
  is("legacy update succeeds", oldUpdate.ok, true);
  is("legacy update preserves stored restrictions", oldUpdate.ok && oldUpdate.draft.audience, savedAudience);
  const cleared = { who: "all", notProductId: null, narrow: null };
  const clearUpdate = await saveDraft(store, "owner@example.com", { ...content, id: savedId, audience: cleared });
  is("explicit clear is saved", clearUpdate.ok && clearUpdate.draft.audience, cleared);
  is("explicit clear survives reload", (await listDraftsStrict(store.listId)).find(d => d.id === savedId)?.audience, cleared);
  const legacy = await saveDraft(store, "owner@example.com", content);
  is("old drafts without audience remain readable", legacy.ok && (await listDraftsStrict(store.listId)).some(d => d.id === legacy.draft.id && d.audience === undefined), true);
  is("missing audience cannot confirm a new editor save", legacy.ok ? confirmedDraftId({ ok: true, draft: legacy.draft }, legacy.draft.id, cleared) : "fixture", null);
  part("Malformed audience restrictions do not become broad defaults");
  const invalid = [null, [], {}, { ...cleared, who: "everyone" }, { ...cleared, notProductId: "" }, { ...cleared, notProductId: 1 }, { ...cleared, narrow: undefined }, { ...cleared, narrow: {} }, { ...cleared, narrow: { minSpent: -1, channel: "", quietDays: 0 } }, { ...cleared, narrow: { minSpent: "2550", channel: "", quietDays: 0 } }, { ...cleared, narrow: { minSpent: 100000001, channel: "", quietDays: 0 } }, { ...cleared, narrow: { minSpent: 0, channel: "bad channel", quietDays: 0 } }, { ...cleared, narrow: { minSpent: 0, channel: "", quietDays: 31 } }];
  const before = (await redis.pipeline([["HGETALL", key]]))[0];
  for (const audience of invalid) {
    is("strict audience parser rejects malformed values", readDraftAudience(audience), null);
    is("invalid request is refused before writing", await saveDraft(store, "owner@example.com", { ...content, id: savedId, audience }), { ok: false, reason: "audience" });
    const record = { id: savedId, ...content, productId: "included", by: "owner@example.com", savedAt: "2026-10-15T00:00:00Z", audience };
    is("corrupt stored audience makes the snapshot unavailable", parseDraftList([savedId, JSON.stringify(record)]), null);
  }
  is("invalid requests preserved all drafts", (await redis.pipeline([["HGETALL", key]]))[0], before);
  is("foreign exclusion product is refused", await saveDraft(store, "owner@example.com", { ...content, audience: { ...cleared, notProductId: "foreign" } }), { ok: false, reason: "product" });
  is("comparison accepts reordered object keys", sameDraftAudience(cleared, { narrow: null, notProductId: null, who: "all" }), true);
  part("An unreadable previous draft cannot lose restrictions during a legacy update");
  const original = redis.pipeline;
  let writes = 0;
  redis.pipeline = async commands => {
    writes += commands.filter(c => c[0] === "HSET" || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:draft-set-held:"))).length;
    if (commands.some(c => c[0] === "HGET")) return [];
    return original.call(redis, commands);
  };
  try {
    let failed = false;
    try { await saveDraft(store, "owner@example.com", { ...content, id: savedId }); } catch (e) { failed = e instanceof DraftReadUnavailable; }
    is("unknown prior audience blocks overwrite", failed, true);
    is("no write after failed prior read", writes, 0);
  } finally { redis.pipeline = original; }
  done();
}
void main();
