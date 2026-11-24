/**
 * 639 [GL7](22), unit 1: the creator's digital business card
 * (lib/creator-card.ts, app/api/store/creator-card/route.ts). Only what the
 * creator typed for it, refused and never cut when wrong, off until turned
 * on; the "Save contact" file as RFC 6350 writes it (escaped, folded at 75
 * octets without splitting a character, CRLF), never for a card that is off;
 * kept with its room taken first, through the real route, session and store.
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/creator-card/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { CARD_REFUSALS, type CreatorCard, MAX_CARD_NAME, MAX_CARD_NOTE, NO_CARD, cardVcard, foldLine, parseCard, readCard, readCreatorCard, saveCreatorCard, vcardFileName, vcardText } from "@/lib/creator-card";
import { storeLiveFence } from "@/lib/store-live-cache";
import { redisPipeline } from "@/lib/redis";
import { dataKey } from "@/lib/store-data";
import { claimHandle, closeStoreRecord, ensureStatsId, ensureStoreId, ERASING_KEY, erasingField, moveAccount, ownerKey, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; card?: CreatorCard };

async function main(): Promise<void> {
  // Made at run time, so no number in this file reads as someone's.
  const typedPhone = "+" + "1 (555) 010-4477";
  const phone = "+" + "15550104477";
  const card: CreatorCard = { on: true, name: "Ana Souza", title: "Course creator", email: "ana@example.com", phone, website: "https://ana.example.com/", note: "Pottery, glazes; kilns" };

  part("Only what the creator typed, never cut");
  const read = readCard({ on: true, name: "  Ana   Souza ", title: "Course creator", email: "ana@example.com", phone: typedPhone, website: "ana.example.com", note: "Pottery, glazes; kilns" });
  is("spaces made single, the phone in its international form, the site as an address", read.ok ? read.card : null, { ...card, website: "https://ana.example.com/" });
  is("a card that is on needs a name", readCard({ on: true, name: " " }), { ok: false, error: "name" });
  is("a card that is off may be empty", readCard({ on: false }), { ok: true, card: NO_CARD });
  is("a name too long is refused, not cut", readCard({ on: true, name: "x".repeat(MAX_CARD_NAME + 1) }), { ok: false, error: "name" });
  is("a line too long is refused", readCard({ on: true, name: "Ana", note: "x".repeat(MAX_CARD_NOTE + 1) }), { ok: false, error: "note" });
  is("an address that is not one", readCard({ on: true, name: "Ana", email: "ana@" }), { ok: false, error: "email" });
  is("a phone without its country code", readCard({ on: true, name: "Ana", phone: "555 010 4477" }), { ok: false, error: "phone" });
  is("a website that is not https", readCard({ on: true, name: "Ana", website: "http://ana.example.com" }), { ok: false, error: "website" });
  is("a value that is not text", readCard({ on: true, name: "Ana", title: 7 }), { ok: false, error: "title" });
  is("every refusal says what to do", Object.values(CARD_REFUSALS).every((words) => /^(Type|Keep) /.test(words)), true);
  is("read back, checked again: anything wrong turns it off", [parseCard({ ...card, email: "nope" }), parseCard("x"), parseCard(card)], [NO_CARD, NO_CARD, card]);

  part("The Save contact file");
  const file = cardVcard(card, "Ana's Pottery", "https://marktmorgen.com/@anapottery")!;
  const lines = file.split("\r\n");
  is("begins and ends as a vCard 4.0, every line ended by CRLF", [lines[0], lines[1], lines[lines.length - 2], lines[lines.length - 1], file.includes("\n") && !/[^\r]\n/.test(file)], ["BEGIN:VCARD", "VERSION:4.0", "END:VCARD", "", true]);
  is("what the card holds, in order", lines.slice(2, -2), [
    "FN:Ana Souza",
    "KIND:individual",
    "TITLE:Course creator",
    "ORG:Ana's Pottery",
    "EMAIL:ana@example.com",
    `TEL;VALUE=uri:tel:${phone}`,
    "URL:https://ana.example.com/",
    "URL:https://marktmorgen.com/@anapottery",
    "NOTE:Pottery\\, glazes\\; kilns",
  ]);
  is("only what is filled in", cardVcard({ ...NO_CARD, on: true, name: "Ana" }, "Ana", "")!.split("\r\n"), ["BEGIN:VCARD", "VERSION:4.0", "FN:Ana", "KIND:individual", "END:VCARD", ""]);
  is("never for a card that is off", cardVcard({ ...card, on: false }, "Ana's Pottery", ""), null);
  is("text escaped as RFC 6350 says", vcardText("a\\b,c;d\ne"), "a\\\\b\\,c\\;d\\ne");
  const long = foldLine("NOTE:" + "é".repeat(60));
  const pieces = long.split("\r\n").filter(Boolean);
  is("folded at 75 octets, each further line starting with a space", [Buffer.byteLength(pieces[0]), pieces.slice(1).every((piece) => piece.startsWith(" ") && Buffer.byteLength(piece) <= 75)], [75, true]);
  is("never inside a character", pieces.map((piece, i) => (i ? piece.slice(1) : piece)).join(""), "NOTE:" + "é".repeat(60));
  is("the file named in plain letters", [vcardFileName(card), vcardFileName({ ...card, name: "Zoë & Ciência" }), vcardFileName({ ...card, name: "!!!" })], ["ana-souza.vcf", "zoe-ciencia.vcf", "contact.vcf"]);

  part("Kept through the studio's route");
  redis.clear();
  const owner = "card@example.com";
  await claimHandle(owner, "cardshop", "Card Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_card", subscriptionId: "sub_card", active: true, tier: "creator", period: paidPeriod() });
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { cookie }) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/creator-card", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const get = async () => (await (await GET(new NextRequest("https://marktmorgen.com/api/store/creator-card", { headers: { cookie } }))).json()) as Reply;
  const statsId = (await storeForEmail(owner))!.statsId;
  is("none yet: off and empty", (await get()).card, NO_CARD);
  const saved = await post({ action: "save", ...card, phone: typedPhone });
  is("saved as typed, made safe", [saved.status, saved.body.card], [200, card]);
  is("and read back", await readCreatorCard(statsId), card);
  const refused = await post({ action: "save", ...card, email: "ana@" });
  is("a refusal says what to do", [refused.status, refused.body.error, refused.body.message], [400, "email", CARD_REFUSALS.email]);
  is("and writes nothing", await readCreatorCard(statsId), card);
  const [taken] = await redisPipeline([["HGET", dataKey((await storeForEmail(owner))!)!, "card"]]);
  is("its room in the store's data room taken first", Number(taken) > 0, true);
  is("forgotten", [(await post({ action: "remove" })).body.card, await readCreatorCard(statsId)], [NO_CARD, NO_CARD]);
  is("an action that is not one", (await post({ action: "print" })).body.error, "unknown");
  const stranger = await post({ action: "save", ...card }, {});
  is("no session: refused, and nothing kept", [stranger.status >= 400 && stranger.status < 500, await readCreatorCard(statsId)], [true, NO_CARD]);


  for (const state of ["live", "erasing", "closed", "moved-live", "moved-erasing"] as const) {
    part(`A card save already admitted when its store is ${state}`);
    redis.clear();
    const actor = "private-card@example.test", handle = "privatecard";
    await claimHandle(actor, handle, "Private contact fixture", "");
    await ensureStatsId(actor);
    await ensureStoreId(actor);
    await setSubscription(actor, { customerId: "cus_CardFence", subscriptionId: "sub_CardFence", active: true, tier: "creator", period: paidPeriod() });
    const parent = (await storeForEmail(actor))!;
    const actorCookie = `${SESSION_COOKIE}=${await openSession(actor)}`;
    const request = (session: string) => POST(new NextRequest("https://marktmorgen.com/api/store/creator-card", {
      method: "POST", headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ action: "save", ...card, on: false }),
    }));
    const key = `nl:vcard:${parent.statsId}`, roomKey = dataKey(parent)!;
    const pipeline = redis.pipeline.bind(redis);
    let hits = 0;
    redis.pipeline = async (commands) => {
      if (!hits && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:card-save") && c[4] === key)) {
        hits++;
        let current = parent;
        if (state.startsWith("moved")) {
          const changed = await moveAccount(actor, "private-card-moved@example.test");
          is("the real account move completes before the final card write", changed.ok, true);
          const found = await storeForEmail("private-card-moved@example.test");
          if (!changed.ok || !found || found.sid !== parent.sid || found.statsId !== parent.statsId) throw new Error("move fixture");
          current = found;
        }
        if (state === "closed") {
          is("real close deletes both card and room", await closeStoreRecord(current, [key, roomKey]), true);
        } else if (state === "erasing" || state === "moved-erasing") {
          await pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(current)), String(Date.now())], ["DEL", key, roomKey]]);
        }
      }
      return pipeline(commands);
    };
    let response: Response;
    try { response = await request(actorCookie); }
    finally { redis.pipeline = pipeline; }
    const result = await response.json() as Reply;
    is("the real POST reaches its final card mutation once", hits, 1);
    const raw = (await pipeline([["GET", key]]))[0];
    if (state === "live") {
      is("live saves preserve private off-card fields", [response.status, result.ok, typeof raw === "string" && raw.includes(card.email) && raw.includes(card.phone)], [200, true, true]);
    } else {
      is("a stale or erased save is not reported successful", [response.status, result.error, Boolean(result.ok)], [410, "gone", false]);
      is("no erased contact record is recreated", raw, null);
      if (state !== "moved-live") is("the erased data-room counter is not recreated either", (await pipeline([["EXISTS", roomKey]]))[0], 0);
      if (state === "erasing" || state === "moved-erasing") {
        const finishing = await storeForEmail(state === "moved-erasing" ? "private-card-moved@example.test" : actor);
        if (!finishing) throw new Error("closing fixture");
        is("final close completes without revisiting card/room", await closeStoreRecord(finishing), true);
        is("no contact data survives final closure", await pipeline([["GET", key], ["EXISTS", roomKey]]), [null, 0]);
      } else if (state === "moved-live") {
        const currentCookie = `${SESSION_COOKIE}=${await openSession("private-card-moved@example.test")}`;
        const fresh = await request(currentCookie);
        is("the moved live store's fresh session still saves", [fresh.status, ((await fresh.json()) as Reply).ok], [200, true]);
      }
    }
  }

  part("An empty-card removal admitted before closure cannot recreate the data room");
  redis.clear();
  const dropOwner = "drop-card@example.test";
  await claimHandle(dropOwner, "dropcard", "Drop fixture", "");
  await ensureStatsId(dropOwner);
  await ensureStoreId(dropOwner);
  await setSubscription(dropOwner, { customerId: "cus_DropCardFence", subscriptionId: "sub_DropCardFence", active: true, tier: "creator", period: paidPeriod() });
  const dropping = (await storeForEmail(dropOwner))!;
  const dropCookie = `${SESSION_COOKIE}=${await openSession(dropOwner)}`;
  const dropKey = `nl:vcard:${dropping.statsId}`, dropRoom = dataKey(dropping)!;
  const dropPipeline = redis.pipeline.bind(redis);
  let dropHits = 0;
  redis.pipeline = async (commands) => {
    if (!dropHits && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:card-drop") && c[4] === dropKey)) {
      dropHits++;
      is("real close precedes the delayed empty-card removal", await closeStoreRecord(dropping, [dropKey, dropRoom]), true);
    }
    return dropPipeline(commands);
  };
  let removal: Response;
  try {
    removal = await POST(new NextRequest("https://marktmorgen.com/api/store/creator-card", { method: "POST", headers: { "content-type": "application/json", cookie: dropCookie }, body: JSON.stringify({ action: "remove" }) }));
  } finally { redis.pipeline = dropPipeline; }
  is("the actual remove mutation is intercepted", dropHits, 1);
  is("closure is reported instead of claiming a live-store removal", [removal.status, ((await removal.json()) as Reply).error], [410, "gone"]);
  is("neither card nor data room is recreated", await dropPipeline([["GET", dropKey], ["EXISTS", dropRoom]]), [null, 0]);

  part("A legacy snapshot is fenced by immutable statsId, never a reused owner key");
  redis.clear();
  const legacyOwner = "legacy-card@example.test";
  await claimHandle(legacyOwner, "legacycard", "Legacy card fixture", "");
  await ensureStatsId(legacyOwner);
  await ensureStoreId(legacyOwner);
  await setSubscription(legacyOwner, { customerId: "cus_LegacyCardFence", subscriptionId: "sub_LegacyCardFence", active: true, tier: "creator", period: paidPeriod() });
  const originalStore = (await storeForEmail(legacyOwner))!;
  const legacy = { ...originalStore, sid: "", extra: false };
  const legacyKey = `nl:vcard:${legacy.statsId}`, legacyRoom = dataKey(legacy)!;
  is("a live legacy identity may save", (await saveCreatorCard(legacy.statsId!, { ...card, on: false }, legacy, await storeLiveFence(legacy))).ok, true);
  is("the actual old record closes", await closeStoreRecord(originalStore, [legacyKey, legacyRoom]), true);
  await claimHandle(legacyOwner, "replacementcard", "Different store", "");
  await ensureStatsId(legacyOwner);
  let gone = "";
  try { await saveCreatorCard(legacy.statsId!, { ...card, on: false }, legacy, await storeLiveFence(legacy)); }
  catch (error) { gone = error instanceof Error ? error.name : String(error); }
  is("a reused owner record is not the erased legacy store", gone, "CardStoreGone");
  is("no old contact or its room is recreated", await redis.pipeline([["GET", legacyKey], ["EXISTS", legacyRoom]]), [null, 0]);

  // A legacy identity read in an unknown shape is never 'gone' or permission to write.
  await redis.pipeline([["SET", await ownerKey(storeRef(legacy)), "{not-json"]]);
  let unknown = "";
  try { await saveCreatorCard(legacy.statsId!, { ...card, on: false }, legacy, await storeLiveFence(legacy)); }
  catch (error) { unknown = error instanceof Error ? error.name : String(error); }
  is("unknown identity is reported unconfirmed", unknown, "CardSaveUnconfirmed");
  is("unknown identity writes neither card nor room", await redis.pipeline([["GET", legacyKey], ["EXISTS", legacyRoom]]), [null, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
