/**
 * The Vercel Blob operations of the doors outside the studio's own pictures (MR audit unit (b), approved by Claude 4,
 * C4-20261106-2790-C56-167), each counted in the line whose figure bounds it, at the official prices read on
 * 6 November 2026 (vercel.com/docs/vercel-blob/usage-and-pricing): a put or a signed token is an Advanced Operation,
 * US$ 5 a million; a head or a read is a Simple Operation, US$ 0.40 a million; every SDK request (put, head, token) up
 * to 11 tries; a get is one plain fetch; a delete is free; a read is counted with its whole bytes.
 *
 *   1. A community picture: its door (a signed token, the browser's put) and its check when a post uses it (a head, a
 *      read of its first bytes). A buyer's door or post takes one of the store's buyer actions; the creator's take
 *      studio requests, already priced inside studio-blob at the dearest studio request.
 *   2. A student's file: its door (a signed token, the browser's put) and its hand-in (a head). Each takes a buyer
 *      action.
 *   3. An email's picture: a put from the server, one of the store's calls to connected services (the integration
 *      figure), and nothing else: no token, no head, no read.
 *
 * Unknown is never zero: a store that pays nothing (a trial) does the same with its own figures, carried by the
 * paying stores' share (nonPayingWorst).
 */
import { readFileSync } from "node:fs";
import * as registry from "./plan-cost-registry";
import { COST_LINES, BLOB_ADVANCED_OP, BLOB_SIMPLE_OP, BLOB_TRANSFER_PER_BYTE, BLOB_PUT_TRIES, BLOB_HEAD_TRIES, BLOB_TOKEN_TRIES, ORIGIN_PER_BYTE, pictureCheckBlob, studioBlobPerRequest } from "./plan-cost-registry";
import { CDN_PER_REQUEST } from "./traffic-cost";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { MAX_IMAGE_BYTES } from "@/lib/product-image";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;
const TIERS = ["creator", "pro", "scale"] as const;

// What a door, a check and a head cost, written here from the prices, not read from the registry's helpers.
const door = (BLOB_PUT_TRIES + BLOB_TOKEN_TRIES) * BLOB_ADVANCED_OP;
// Changed (rule 23, Claude 2 on #2852, 6751277724, MEDIUM): the check's read is the same private get the studio's
// picture check makes (lib/community-files.ts, lib/picture-check.ts), so it crosses at Fast Origin Transfer too and is
// one CDN request, as pictureCheckBlob counts it; the community path sends no clean-up head (it only deletes).
const check = BLOB_HEAD_TRIES * BLOB_SIMPLE_OP + BLOB_SIMPLE_OP + MAX_IMAGE_BYTES * (BLOB_TRANSFER_PER_BYTE + ORIGIN_PER_BYTE) + CDN_PER_REQUEST;
const handInHead = BLOB_HEAD_TRIES * BLOB_SIMPLE_OP;
const perBuyerAction = Math.max(door, check, handInHead);
const mailPut = BLOB_PUT_TRIES * BLOB_ADVANCED_OP;

part("What the code does at each door (read from the routes, so a new operation fails here)");
const communityDoor = read("app/api/store/community/upload/route.ts");
is("a community door signs one token, takes a buyer action (the creator's: a studio request) and a picture's place first", [count(communityDoor, "issueSignedToken({"), communityDoor.includes('takeBuyerAction(store, viewer.owner ? "owner" : "buyer")'), communityDoor.includes("takePicturePlace(pathname")], [1, true, true]);
is("a community door asks the store nothing else (no head, no read, no list)", /\b(head|get|list|put)\(/.test(communityDoor.replace(/issueSignedToken\(/g, "")), false);
is("the door's file is at most MAX_IMAGE_BYTES (the token says so)", communityDoor.includes("maximumSizeInBytes: MAX_IMAGE_BYTES"), true);
const communityPost = read("app/api/store/community/route.ts");
is("a post checks one picture at most, after its own buyer action", [count(communityPost, "checkCommunityImage(path, id, blobImages)"), communityPost.includes('takeBuyerAction(store, owner ? "owner" : "buyer")')], [1, true]);
const communityImage = read("lib/community-image.ts");
is("the check is one head and one read of the first bytes", [count(communityImage, "files.head("), count(communityImage, "files.firstBytes(")], [1, 1]);
const communityFiles = read("lib/community-files.ts");
is("the first bytes are one plain get, canceled after sixteen bytes", [count(communityFiles, "await get("), communityFiles.includes("reader.cancel()")], [1, true]);
const taskDoor = read("app/api/store/course/task/upload/route.ts");
is("a student's door signs one token after a buyer action, its file at most MAX_TASK_FILE_BYTES", [count(taskDoor, "issueSignedToken({"), taskDoor.includes("takeBuyerAction(on.store)"), taskDoor.includes("maximumSizeInBytes: MAX_TASK_FILE_BYTES")], [1, true, true]);
is("a student's door asks the store nothing else", /\b(head|get|list|put)\(/.test(taskDoor.replace(/issueSignedToken\(/g, "")), false);
const handIn = read("app/api/store/course/task/route.ts");
is("a hand-in heads one file at most, after its buyer action", [count(handIn, "headFile("), handIn.includes("takeBuyerAction(store)")], [1, true]);
const mailPictures = read("lib/mail-pictures.ts");
is("an email's picture is one put from the server, and nothing else", [count(mailPictures, "await put("), /\b(head|get|list|issueSignedToken)\(/.test(mailPictures)], [1, false]);
const mailRoute = read("app/api/store/mail/picture/route.ts");
is("it is one of the store's calls to connected services, taken before the put", mailRoute.indexOf('withinServiceWhy("mail-picture"') > 0 && mailRoute.indexOf('withinServiceWhy("mail-picture"') < mailRoute.indexOf("keepMailPicture(ref"), true);

part("A community picture's check is priced as the studio's picture check is, less its clean-up head");
is("at least pictureCheckBlob less the clean-up head the community path does not send", check >= pictureCheckBlob(MAX_IMAGE_BYTES) - BLOB_HEAD_TRIES * BLOB_SIMPLE_OP - 1e-12, true);
is("so the dearest buyer action is the check, not the door", [check > door, registry.buyerBlobPerAction() >= check - 1e-12], [true, true]);

part("The creator's community doors and checks are studio requests, inside studio-blob");
is("a studio request is already priced above a community door", studioBlobPerRequest() >= door, true);
is("and above a community picture's check", studioBlobPerRequest() >= check, true);

part("The buyers' doors, checks and hand-ins: line buyer-blob");
const buyer = COST_LINES.find((line) => line.id === "buyer-blob");
is("a line of its own", Boolean(buyer), true);
const perAction = (registry as Record<string, unknown>).buyerBlobPerAction;
// Changed (rule 23, Claude 2 on #2852, 6751277724): with its read counted as the studio's is, the check is the dearest.
is("each buyer action at the dearest Blob work it may be: a post's check (a head, a read through the origin and the CDN)", Math.abs((typeof perAction === "function" ? (perAction as () => number)() : Number.NaN) - perBuyerAction) < 1e-15, true);
is("a check is the dearest of the three today", perBuyerAction, check);
for (const tier of TIERS) {
  is(`${tier}: the buyer figure (${STORE_ALLOWANCES[tier].buyer}), each action at the dearest`, Math.abs((buyer?.monthlyUsd(tier) ?? 0) - STORE_ALLOWANCES[tier].buyer * perBuyerAction) < 1e-12, true);
}
const buyerFiles = new Set(buyer?.sources.map((source) => source.file) ?? []);
is("its sources: both doors, the post's check and the hand-in", ["app/api/store/community/upload/route.ts", "app/api/store/community/route.ts", "lib/community-image.ts", "lib/community-files.ts", "app/api/store/course/task/upload/route.ts", "app/api/store/course/task/route.ts", "lib/store-allowance-rules.ts"].every((file) => buyerFiles.has(file)), true);
is("its basis says the source, the date and why a read is counted whole", (buyer?.basis ?? "").includes("vercel.com/docs/vercel-blob/usage-and-pricing") && /6 November 2026/.test(buyer?.basis ?? "") && /206/.test(buyer?.basis ?? ""), true);

part("An email's picture: line mail-picture-blob");
const mail = COST_LINES.find((line) => line.id === "mail-picture-blob");
is("a line of its own", Boolean(mail), true);
for (const tier of TIERS) {
  is(`${tier}: the integration figure (${STORE_ALLOWANCES[tier].integration}), each a put with every try`, Math.abs((mail?.monthlyUsd(tier) ?? 0) - STORE_ALLOWANCES[tier].integration * mailPut) < 1e-12, true);
}
const mailFiles = new Set(mail?.sources.map((source) => source.file) ?? []);
is("its sources: the route, the put and the figure", ["app/api/store/mail/picture/route.ts", "lib/mail-pictures.ts", "lib/metered-limits.ts", "lib/store-allowance-rules.ts"].every((file) => mailFiles.has(file)), true);
is("its basis says the source and the date", (mail?.basis ?? "").includes("vercel.com/docs/vercel-blob/usage-and-pricing") && /6 November 2026/.test(mail?.basis ?? ""), true);

part("A store that pays nothing does the same with its own figures (nonPayingWorst)");
const source = read("tests/plan-cost-registry.ts");
const body = source.slice(source.indexOf("export function nonPayingWorst("), source.indexOf("\n}", source.indexOf("export function nonPayingWorst(")));
is("its buyer figure's Blob work and its email pictures are in the share the paying stores carry", [body.includes("allowances.buyer * buyerBlobPerAction()"), body.includes("allowances.integration * MAIL_PICTURE_BLOB")], [true, true]);

part("studio-blob no longer says community pictures and students' files are counted nowhere");
const studio = COST_LINES.find((line) => line.id === "studio-blob");
is("it names the creator's community doors and checks as studio requests, and the lines that hold the rest", /creator's own community/.test(studio?.basis ?? "") && /buyer-blob/.test(studio?.basis ?? "") && /mail-picture-blob/.test(studio?.basis ?? ""), true);

part("A door token does not bound refused puts beyond the SDK retry model (C6 LOW 6696572596)");
for (const line of [buyer, studio]) {
  const basis = line?.basis ?? "";
  is(`${line?.id}: the basis discloses refused puts beyond SDK tries as unbounded`, /refused puts[^.]*beyond[^.]*not bounded/i.test(basis), true);
  is(`${line?.id}: their extra billing and cost stay unknown, never zero`, /Whether those refused puts are billed is unknown/.test(basis) && /additional cost is unknown, never zero/.test(basis), true);
}
done();
