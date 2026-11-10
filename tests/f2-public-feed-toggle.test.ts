/**
 * 33 [F2], part 3: the studio's control for a podcast's public feed (app/api/store/podcast/public-settings/route.ts,
 * components/podcast-public-feed.tsx), which writes the settings the public feed of part 2 reads
 * (nl:pod:<id>:public, lib/podcast-public-show.ts).
 *
 * What is checked:
 *   - nothing is public by itself: turning the feed on needs the creator to say they understood it is public, a
 *     category and an explicit flag, and publishes no episode; each episode goes in only when the creator marks it,
 *     with an https address of their own for its audio (never ours, never one holding a buyer's token or address);
 *   - a draft (hidden) product never gets a public feed, and a product that is not a podcast is refused;
 *   - rule 24: only Redis's exact "OK" is a write and only 0 or 1 a deletion; a settings record or a product that
 *     cannot be read is a 503 and nothing is written;
 *   - the record is counted in the store's data room before it is written and given back when the feed is turned off;
 *   - the record goes when the feed is turned off, and with the store when it closes (the erasing walk, by the
 *     podcast's id); it names no person, so a person's erasure has nothing of it to take.
 *
 * Synthetic data only; the Redis double, no network.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductHidden, setProductPodcast, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { savePodcast } from "@/lib/podcast";
import type { Podcast } from "@/lib/podcast-rules";
import { forgetPublicFeeds } from "@/lib/podcast-public-show";
import { dataKey } from "@/lib/store-data";
import { eraseClosed, markDue } from "@/lib/closed-store-data";
import { GET as feed } from "@/app/api/store/podcast/public/[handle]/[product]/route";
import { POST as productRoute } from "@/app/api/store/product/route";
import { turnOnMissing } from "@/components/podcast-public-feed";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

globalThis.fetch = (async () => {
  throw new Error("no request may be made here");
}) as typeof fetch;

const OWNER = "wave@example.com";
const OTHER = "shore@example.com";
const HANDLE = "wavecast";
const POD = "b".repeat(32);
const OTHER_POD = "c".repeat(32);
const KEY = `nl:pod:${POD}:public`;
const ORIGIN = "https://marktmorgen.com";
const AUDIO = "https://cdn.example.org/wave/ep1.mp3";

const original = redis.pipeline.bind(redis);
let bend: ((command: (string | number)[]) => unknown) | null = null;
const sent: string[] = [];
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(command.map(String).join(" "));
  if (bend && commands.length === 1) {
    const bent = bend(commands[0]);
    if (bent !== undefined) return [bent];
  }
  return original(commands);
}) as typeof redis.pipeline;

type Route = { POST: (request: NextRequest) => Promise<Response> };
/** The route, or null while it does not exist (the RED run counts every check as failing, not one import). */
async function route(): Promise<Route | null> {
  try {
    return (await import("@/app/api/store/podcast/public-settings/route")) as Route;
  } catch {
    return null;
  }
}

let session = "";
async function post(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const found = await route();
  if (!found) return { status: 0, body: {} };
  const response = await found.POST(
    new NextRequest(`${ORIGIN}/api/store/podcast/public-settings`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }),
  );
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

const stored = () => redis.run(["GET", KEY]) as string | null;
const guids = (xml: string) => [...xml.matchAll(/<guid isPermaLink="false">([^<]+)<\/guid>/g)].map((m) => m[1]);

async function publicFeed(pid: string): Promise<{ status: number; xml: string }> {
  forgetPublicFeeds();
  const response = await feed(new NextRequest(`${ORIGIN}/api/store/podcast/public/${HANDLE}/${pid}.xml`), { params: Promise.resolve({ handle: HANDLE, product: `${pid}.xml` }) });
  return { status: response.status, xml: await response.text() };
}

function podcast(id: string): Podcast {
  const one = (n: number) => ({ id: `ep000000000${n}`, title: `Episode ${n}`, notes: "", pathname: `stores/x/p/${n}.mp3`, bytes: 1000 + n, contentType: "audio/mpeg", at: 1_790_000_000 + n });
  return { id, episodes: [one(1), one(2), one(3)] };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Wave Talks", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_wave00001", subscriptionId: "sub_wave00001", active: true, tier: "creator", period: paidPeriod() });
  // A paid podcast: its episodes are its buyers', and none may become public unless the creator marks it.
  const made = await addProduct(OWNER, "Wave Talks Weekly", "A weekly show about waves.", "9", null);
  if (!made.ok) throw new Error("no product");
  const pid = made.product.id;
  if (!(await setProductPodcast(OWNER, pid, { id: POD, episodes: 3 })).ok) throw new Error("no podcast");
  await savePodcast(podcast(POD));
  const plain = await addProduct(OWNER, "A plain download", "", "5", null);
  if (!plain.ok) throw new Error("no plain product");
  session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER)) as Store;
  const room = dataKey(store) ?? "";
  const slot = () => redis.run(["HGET", room, `pod:${POD}:public`]);

  part("Off until the creator turns it on: nothing public, the feed is not there");
  const first = await post({ action: "read", id: pid });
  is("read: off, no episode, the address it would have", [first.status, (first.body.feed as Record<string, unknown> | undefined)?.on, (first.body.feed as Record<string, unknown> | undefined)?.address], [200, false, `${ORIGIN}/api/store/podcast/public/${HANDLE}/${pid}.xml`]);
  is("no record, and the public feed answers 404", [stored(), (await publicFeed(pid)).status], [null, 404]);

  part("Turning it on needs the creator's yes to a public feed, a category and an explicit flag");
  is("without saying they understood it is public: refused", (await post({ action: "on", id: pid, category: "Education", explicit: false })).body.error, "understood");
  is("an understood that is not exactly true: refused", (await post({ action: "on", id: pid, category: "Education", explicit: false, understood: "yes" })).body.error, "understood");
  is("a category that is not one: refused", (await post({ action: "on", id: pid, category: "Gossip", explicit: false, understood: true })).body.error, "category");
  is("an explicit flag that is not true or false: refused", (await post({ action: "on", id: pid, category: "Education", explicit: "no", understood: true })).body.error, "explicit");
  is("not a podcast: refused", (await post({ action: "on", id: plain.product.id, category: "Education", explicit: false, understood: true })).body.error, "not_podcast");
  is("nothing written by any refusal", stored(), null);

  part("A draft never gets a public feed");
  await setProductHidden(OWNER, pid, true);
  const draft = await post({ action: "on", id: pid, category: "Education", explicit: false, understood: true });
  is("a hidden product: refused as private, nothing written", [draft.status, draft.body.error, stored()], [409, "private", null]);
  await setProductHidden(OWNER, pid, false);

  part("On: the record is written and counted, and no episode is public by itself");
  const on = await post({ action: "on", id: pid, category: "Education", explicit: false, understood: true });
  is("on, with no episode in it", [on.status, (on.body.feed as Record<string, unknown> | undefined)?.on, (on.body.feed as Record<string, unknown> | undefined)?.episodes], [200, true, {}]);
  is("the record the public feed reads", JSON.parse(stored() ?? "null"), { category: "Education", explicit: false, episodes: {} });
  is("counted in the store's data room before it was written", Number(slot()) > 0, true);
  const empty = await publicFeed(pid);
  is("the public feed is there, with no episode: a paid episode is never made public by turning it on", [empty.status, guids(empty.xml)], [200, []]);

  part("An episode goes in only when the creator marks it, with an https address of their own");
  is("not https: refused", (await post({ action: "episode", id: pid, episode: "ep0000000001", public: true, audio: "http://cdn.example.org/wave/ep1.mp3" })).body.error, "not_https");
  is("our own site: refused", (await post({ action: "episode", id: pid, episode: "ep0000000001", public: true, audio: "https://marktmorgen.com/api/store/podcast/play/x.mp3" })).body.error, "ours");
  is("our private file store: refused", (await post({ action: "episode", id: pid, episode: "ep0000000001", public: true, audio: "https://abc.public.blob.vercel-storage.com/stores/x/p/1.mp3" })).body.error, "ours");
  is("our vault: refused", (await post({ action: "episode", id: pid, episode: "ep0000000001", public: true, audio: "https://acct.r2.cloudflarestorage.com/vault/1.mp3" })).body.error, "ours");
  is("an address holding a buyer's token: refused", (await post({ action: "episode", id: pid, episode: "ep0000000001", public: true, audio: `https://cdn.example.org/${"f".repeat(48)}/1.mp3` })).body.error, "buyer_data");
  is("an address holding an email address: refused", (await post({ action: "episode", id: pid, episode: "ep0000000001", public: true, audio: "https://cdn.example.org/a@b.example/1.mp3" })).body.error, "buyer_data");
  is("an episode the podcast does not have: refused", (await post({ action: "episode", id: pid, episode: "ep0000000009", public: true, audio: AUDIO })).body.error, "unknown");
  is("still no episode in the record", JSON.parse(stored() ?? "null")?.episodes, {});
  const marked = await post({ action: "episode", id: pid, episode: "ep0000000001", public: true, audio: AUDIO });
  is("marked public", [marked.status, (marked.body.feed as Record<string, unknown> | undefined)?.episodes], [200, { ep0000000001: AUDIO }]);
  is("written exactly as the feed reads it", JSON.parse(stored() ?? "null")?.episodes, { ep0000000001: { visibility: "public", audio: AUDIO } });
  const one = await publicFeed(pid);
  is("the public feed holds that one episode only", [one.status, guids(one.xml)], [200, ["ep0000000001"]]);
  const unmarked = await post({ action: "episode", id: pid, episode: "ep0000000001", public: false });
  is("taken out again", [unmarked.status, JSON.parse(stored() ?? "null")?.episodes], [200, {}]);
  is("and gone from the public feed", guids((await publicFeed(pid)).xml), []);

  part("Rule 24: only an exact OK is a write, only 0 or 1 a deletion, and an unknown read writes nothing");
  for (const reply of [null, "QUEUED", 1, ["OK"]]) {
    bend = (command) => (command[0] === "SET" && command[1] === KEY ? reply : undefined);
    const bent = await post({ action: "episode", id: pid, episode: "ep0000000002", public: true, audio: AUDIO });
    bend = null;
    is(`a SET answered ${JSON.stringify(reply)}: 503, never ok`, [bent.status, bent.body.ok, bent.body.error], [503, false, "unavailable"]);
  }
  await post({ action: "episode", id: pid, episode: "ep0000000002", public: false });
  for (const reply of [42, "not json", "{\"episodes\":[]}"]) {
    bend = (command) => (command[0] === "GET" && command[1] === KEY ? reply : undefined);
    sent.length = 0;
    const bent = await post({ action: "episode", id: pid, episode: "ep0000000003", public: true, audio: AUDIO });
    bend = null;
    is(`settings read as ${JSON.stringify(reply)}: 503 and no write`, [bent.status, bent.body.error, sent.some((c) => c.startsWith(`SET ${KEY}`))], [503, "unavailable", false]);
  }
  bend = (command) => (command[0] === "DEL" && command[1] === KEY ? "1" : undefined);
  const badDel = await post({ action: "off", id: pid });
  bend = null;
  is("a deletion answered \"1\" (text): 503, the room not given back", [badDel.status, badDel.body.error, Number(slot()) > 0], [503, "unavailable", true]);

  part("Off: the record is deleted and its room given back; the public feed is gone");
  const off = await post({ action: "off", id: pid });
  is("off", [off.status, (off.body.feed as Record<string, unknown> | undefined)?.on], [200, false]);
  is("no record, no room taken", [stored(), slot()], [null, null]);
  is("the public feed answers 404", (await publicFeed(pid)).status, 404);
  is("marking an episode while it is off: refused", (await post({ action: "episode", id: pid, episode: "ep0000000001", public: true, audio: AUDIO })).body.error, "off");

  part("It names no person: nothing in it a person's erasure would have to take");
  await post({ action: "on", id: pid, category: "Education", explicit: true, understood: true });
  await post({ action: "episode", id: pid, episode: "ep0000000001", public: true, audio: AUDIO });
  is("only the show's category and flag, and each episode's mark and audio address", Object.keys(JSON.parse(stored() ?? "{}")).sort(), ["category", "episodes", "explicit"]);
  is("no address of anybody in it", (stored() ?? "").includes(OWNER) || /@/.test(stored() ?? ""), false);

  // Review of #3544 (Claude 3, MÉDIO 1): the box is shown only while the feed is off, so it is asked for only then.
  part("A creator who comes back with the feed on can save the category and explicit setting");
  is("feed on, a fresh page (box not shown, so not checked), a category and a flag: nothing missing", turnOnMissing({ on: true, understood: false, category: "Education", explicit: false }), null);
  is("control: turning it on still needs the box", turnOnMissing({ on: false, understood: false, category: "Education", explicit: false }), "understood");
  is("a category and a flag are still asked for, on or off", [turnOnMissing({ on: true, understood: false, category: "", explicit: false }), turnOnMissing({ on: false, understood: true, category: "Arts", explicit: null })], ["category", "explicit"]);

  // Review of #3544 (Claude 3, MÉDIO 2): removing the product takes its public settings and their room with it.
  part("Removing the podcast's product deletes its public settings and gives their room back");
  {
    const POD2 = "d".repeat(32);
    const KEY2 = `nl:pod:${POD2}:public`;
    const gone = await addProduct(OWNER, "A show that goes", "", "9", null);
    if (!gone.ok) throw new Error("no product");
    if (!(await setProductPodcast(OWNER, gone.product.id, { id: POD2, episodes: 3 })).ok) throw new Error("no podcast");
    await savePodcast(podcast(POD2));
    await post({ action: "on", id: gone.product.id, category: "Education", explicit: false, understood: true });
    is("control: on, with its record and its room", [redis.run(["EXISTS", KEY2]), Number(redis.run(["HGET", room, `pod:${POD2}:public`])) > 0], [1, true]);
    const removed = await productRoute(
      new NextRequest(`${ORIGIN}/api/store/product`, { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "remove", id: gone.product.id }) }),
    );
    is("the product is removed", [removed.status, ((await removed.json()) as { ok?: boolean }).ok], [200, true]);
    is("its public settings are deleted", redis.run(["EXISTS", KEY2]), 0);
    is("and their room given back", redis.run(["HGET", room, `pod:${POD2}:public`]), null);
  }

  part("The store's closing erases it, by the podcast's id; another store's stays");
  await claimHandle(OTHER, "shorecast", "Shore", "");
  await ensureStatsId(OTHER);
  redis.run(["SET", `nl:pod:${OTHER_POD}:public`, JSON.stringify({ category: "Arts", explicit: false, episodes: {} })]);
  is("there before the closing", stored() !== null, true);
  const T = Date.now();
  await markDue(OWNER, T - 1000);
  for (let run = 0; run < 6 && !(await eraseClosed(Date.now() + 30_000, async () => {}, T)).done; run += 1);
  is("the closed store's public feed settings are gone", stored(), null);
  is("another store's are kept", redis.run(["EXISTS", `nl:pod:${OTHER_POD}:public`]), 1);

  done();
}

void main();
