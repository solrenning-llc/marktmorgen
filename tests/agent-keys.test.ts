/**
 * 631 [AA1] (c), unit 3: keys an AI agent prepares changes with (lib/api-keys.ts,
 * lib/api-guard.ts apiAgent). A key prepares nothing unless made to; a draft
 * key cannot prepare execute changes; a key that writes is not an agent key;
 * an agent key does not write directly; revoking works at once; preparing
 * waits while the plan is unpaid. Synthetic store, no outside request.
 */
import { listKeys, makeKey, resolveKey, revokeKey } from "@/lib/api-keys";
import { agentMay, agentScopeOf } from "@/lib/api-key-rules";
import { apiAgent, apiStore, apiWriter } from "@/lib/api-guard";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { API_WRITE_PAUSED_WORDS } from "@/lib/integration-pause";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "agent-keys@example.com";

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => {
    outside += 1;
    throw new Error("No outside requests in this test");
  }) as typeof fetch;
  try {
    await claimHandle(OWNER, "agent-keys-shop", "Agent Keys Shop", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_AgentKeys001", subscriptionId: "sub_AgentKeys001", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    const store = (await storeForEmail(OWNER))!;

    part("The scope itself");
    is("anything unknown is none", [agentScopeOf(undefined), agentScopeOf("admin"), agentScopeOf(true)], ["none", "none", "none"]);
    is("draft prepares drafts only", [agentMay("draft", "draft"), agentMay("draft", "execute")], [true, false]);
    is("execute prepares both", [agentMay("execute", "draft"), agentMay("execute", "execute")], [true, true]);
    is("none prepares nothing", [agentMay("none", "draft"), agentMay("none", "execute")], [false, false]);

    part("Keys made before, and keys made without a scope, prepare nothing");
    const reader = await makeKey(store.sid, "Synthetic reader");
    const writer = await makeKey(store.sid, "Synthetic writer", Date.now(), true);
    const drafter = await makeKey(store.sid, "Synthetic agent drafts", Date.now(), false, "draft");
    const executor = await makeKey(store.sid, "Synthetic agent all", Date.now(), false, "execute");
    if (!reader.ok || !writer.ok || !drafter.ok || !executor.ok) throw new Error("No synthetic keys");
    is("made keys say their scope", [reader.made.agent, writer.made.agent, drafter.made.agent, executor.made.agent], ["none", "none", "draft", "execute"]);
    is("the list says each key's scope", (await listKeys(store.sid)).map((k) => [k.name, k.write, k.agent]).sort(), [
      ["Synthetic agent all", false, "execute"],
      ["Synthetic agent drafts", false, "draft"],
      ["Synthetic reader", false, "none"],
      ["Synthetic writer", true, "none"],
    ]);
    // A key stored before 2 November 2026 has no `agent` field at all.
    const listKey = `nl:api:keys:${store.sid}`;
    const [rawOld] = (await redis.pipeline([["HGET", listKey, reader.made.id]])) as [string];
    const old = JSON.parse(rawOld) as Record<string, unknown>;
    delete old.agent;
    await redis.pipeline([["HSET", listKey, reader.made.id, JSON.stringify(old)]]);
    is("a key stored before the scope existed reads as none", (await resolveKey(reader.key))?.agent, "none");
    await redis.pipeline([["HSET", listKey, reader.made.id, JSON.stringify({ ...old, agent: "everything" })]]);
    is("a scope that is not one of the three reads as none", (await resolveKey(reader.key))?.agent, "none");
    is("a scope sent that is not one of the three makes a key that prepares nothing", (await makeKey(store.sid, "Odd", Date.now(), false, "admin" as never)).ok && (await listKeys(store.sid)).find((k) => k.name === "Odd")?.agent, "none");

    const ask = (key: string) => new Request("https://marktmorgen.com/api/mcp", { method: "POST", headers: { Authorization: `Bearer ${key}` } });
    const answer = async (got: unknown) => (got instanceof Response ? { status: got.status, error: ((await got.json()) as { error?: string }).error } : { status: 200, error: null });

    part("Only an agent key prepares, and only what its scope allows");
    is("a read key cannot prepare", await answer(await apiAgent(ask(reader.key), "draft")), { status: 403, error: "cannot_prepare" });
    is("a key that writes leads is not an agent key", await answer(await apiAgent(ask(writer.key), "draft")), { status: 403, error: "cannot_prepare" });
    is("a draft key prepares drafts", await answer(await apiAgent(ask(drafter.key), "draft")), { status: 200, error: null });
    is("a draft key cannot prepare execute changes", await answer(await apiAgent(ask(drafter.key), "execute")), { status: 403, error: "cannot_prepare_execute" });
    is("an execute key prepares both", [await answer(await apiAgent(ask(executor.key), "draft")), await answer(await apiAgent(ask(executor.key), "execute"))], [{ status: 200, error: null }, { status: 200, error: null }]);
    const granted = await apiAgent(ask(executor.key), "draft");
    is("it says which store and which key", granted instanceof Response ? null : [granted.store.sid, granted.keyId, granted.agent], [store.sid, executor.made.id, "execute"]);
    is("no key: refused", await answer(await apiAgent(ask(""), "draft")), { status: 401, error: "unauthorized" });

    part("An agent key reads, and never writes directly");
    is("it reads the store", (await apiStore(ask(drafter.key))) instanceof Response, false);
    is("it cannot write: changes go through the creator's confirmation", await answer(await apiWriter(ask(executor.key))), { status: 403, error: "read_only" });

    part("Revoked at once");
    is("revoked", await revokeKey(store.sid, drafter.made.id), true);
    is("the next request is refused", await answer(await apiAgent(ask(drafter.key), "draft")), { status: 401, error: "unauthorized" });

    part("Preparing waits while the plan's renewal is unpaid");
    await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
    const paused = await apiAgent(ask(executor.key), "draft");
    const pausedBody = paused instanceof Response ? ((await paused.json()) as { error?: string; message?: string }) : null;
    is("refused with the write sentence", [paused instanceof Response ? paused.status : 200, pausedBody?.error, pausedBody?.message], [409, "paused_unpaid", API_WRITE_PAUSED_WORDS.paused_unpaid]);
    is("a key that cannot prepare still hears it cannot", await answer(await apiAgent(ask(reader.key), "draft")), { status: 403, error: "cannot_prepare" });

    is("nothing reached outside", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

void main();
