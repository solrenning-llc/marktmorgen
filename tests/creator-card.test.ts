/**
 * 639 [GL7](22), unit 1: the creator's digital business card
 * (lib/creator-card.ts, app/api/store/creator-card/route.ts). Only what the
 * creator typed for it, refused and never cut when wrong, off until turned
 * on; the "Save contact" file as RFC 6350 writes it (escaped, folded at 75
 * octets without splitting a character, CRLF), never for a card that is off;
 * kept with its room taken first, through the real route, session and store.
 *
 * Gap, not tested: the file has not been opened in real contact apps (iOS,
 * Android, Outlook, macOS Contacts); only its text against RFC 6350 is held here.
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/creator-card/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { CARD_REFUSALS, type CreatorCard, MAX_CARD_NAME, MAX_CARD_NOTE, NO_CARD, cardVcard, foldLine, parseCard, readCard, readCreatorCard, vcardFileName, vcardFileNameStar, vcardText } from "@/lib/creator-card";
import { redisPipeline } from "@/lib/redis";
import { dataKey } from "@/lib/store-data";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; card?: CreatorCard };

async function main(): Promise<void> {
  // Made at run time, so no number in this file reads as someone's.
  const typedPhone = "+" + "1 (555) 010-4477";
  const phone = "+" + "15550104477";
  // Kept as typed, grouped the creator's way; dialled from its digits.
  const card: CreatorCard = { on: true, name: "Ana Souza", title: "Course creator", email: "ana@example.com", phone: typedPhone, website: "https://ana.example.com/", note: "Pottery, glazes; kilns" };

  part("Only what the creator typed, never cut");
  const read = readCard({ on: true, name: "  Ana   Souza ", title: "Course creator", email: "ana@example.com", phone: typedPhone, website: "ana.example.com", note: "Pottery, glazes; kilns" });
  is("spaces made single, the phone kept as typed, the site as an address", read.ok ? read.card : null, { ...card, website: "https://ana.example.com/" });
  is("a phone that is not one is still refused", [readCard({ on: true, name: "Ana", phone: "+1 555 CALL ME" }), readCard({ on: true, name: "Ana", phone: "+1 555" })], [{ ok: false, error: "phone" }, { ok: false, error: "phone" }]);
  is("a card kept before, its phone in the international form, still reads", parseCard({ ...card, phone }).phone, phone);
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
    "N:;Ana Souza;;;",
    "TITLE:Course creator",
    "ORG:Ana's Pottery",
    "EMAIL:ana@example.com",
    `TEL;VALUE=uri:tel:${phone}`,
    "URL:https://ana.example.com/",
    "URL:https://marktmorgen.com/@anapottery",
    "NOTE:Pottery\\, glazes\\; kilns",
  ]);
  is("only what is filled in", cardVcard({ ...NO_CARD, on: true, name: "Ana" }, "Ana", "")!.split("\r\n"), ["BEGIN:VCARD", "VERSION:4.0", "FN:Ana", "N:;Ana;;;", "END:VCARD", ""]);
  is("N for the apps that read it: the whole name, escaped, never split into a guessed family name", cardVcard({ ...NO_CARD, on: true, name: "Studio Ana; Co, Ltd" }, "", "")!.split("\r\n")[3], "N:;Studio Ana\\; Co\\, Ltd;;;");
  is("no KIND: the card does not say whether it is a person or a business", file.includes("KIND:"), false);
  is("never for a card that is off", cardVcard({ ...card, on: false }, "Ana's Pottery", ""), null);
  is("text escaped as RFC 6350 says", vcardText("a\\b,c;d\ne"), "a\\\\b\\,c\\;d\\ne");
  const long = foldLine("NOTE:" + "é".repeat(60));
  const pieces = long.split("\r\n").filter(Boolean);
  is("folded at 75 octets, each further line starting with a space", [Buffer.byteLength(pieces[0]), pieces.slice(1).every((piece) => piece.startsWith(" ") && Buffer.byteLength(piece) <= 75)], [75, true]);
  is("never inside a character", pieces.map((piece, i) => (i ? piece.slice(1) : piece)).join(""), "NOTE:" + "é".repeat(60));
  is("the file named in plain letters", [vcardFileName(card), vcardFileName({ ...card, name: "Zoë & Ciência" }), vcardFileName({ ...card, name: "!!!" })], ["ana-souza.vcf", "zoe-ciencia.vcf", "contact.vcf"]);
  is("and as written, for a name beyond ASCII (RFC 8187)", [vcardFileNameStar(card), vcardFileNameStar({ ...card, name: "Zoë & Ciência" }), vcardFileNameStar({ ...card, name: "山田 花子" }), vcardFileNameStar({ ...card, name: "Zoë/Ana's (shop)*" })], [null, "UTF-8''Zo%C3%AB%20%26%20Ci%C3%AAncia.vcf", "UTF-8''%E5%B1%B1%E7%94%B0%20%E8%8A%B1%E5%AD%90.vcf", "UTF-8''Zo%C3%AB-Ana%27s%20%28shop%29.vcf"]);
  is("never cut inside a character", decodeURIComponent(vcardFileNameStar({ ...card, name: "😀".repeat(70) })!.slice(7)), `${"😀".repeat(60)}.vcf`);

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
  const saved = await post({ action: "save", ...card });
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

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
