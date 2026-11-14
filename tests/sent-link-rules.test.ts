/**
 * Where a link in a sent email goes, and changing it afterwards (124
 * [F2-EDIT-SENT-LINKS], unit 1: lib/sent-link-rules.ts; nothing sends or
 * answers one yet).
 *
 * What fails here:
 *   - the redirect usable for any address (an open redirect): the original
 *     address must be signed with the email and the link's number;
 *   - a link that dies when nothing was changed, or once a change is no
 *     longer kept (it goes where it was written to go);
 *   - a destination that is not a plain web address: another scheme,
 *     credentials, no dot, an address of ours that loops;
 *   - a change without its history, or a history that grows without end;
 *   - anything in the link that names the reader (it is the same for all).
 */
import { MAX_LINK_CHANGES, MAX_SENT_LINKS, MAX_SENT_LINK_URL, readSentLinkTarget, sentLinkGoesTo, sentLinkPath, readSentLinkPath, changeSentLink } from "@/lib/sent-link-rules";
import { createHash } from "node:crypto";
import { done, is, part } from "./check";

const ID = "0123456789abcdef01234567";
const SID = "aaaabbbbccccddddeeeeffff00001111";
const sign = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
const verify = (text: string, s: string) => s === sign(text);

part("A destination a creator may choose");
is("an https address", readSentLinkTarget("https://example.com/guide?x=1#top"), { ok: true, to: "https://example.com/guide?x=1#top" });
is("spaces around it trimmed", readSentLinkTarget("  https://example.com/a  "), { ok: true, to: "https://example.com/a" });
is("http is kept as written", readSentLinkTarget("http://example.com/a"), { ok: true, to: "http://example.com/a" });
for (const [what, raw] of [
  ["javascript", "javascript:alert(1)"],
  ["data", "data:text/html,hi"],
  ["mailto", "mailto:a@example.com"],
  ["credentials", "https://user:pass@example.com/"],
  ["no dot in the host", "https://localhost/a"],
  ["a bare word", "example"],
  ["our own redirect, which would loop", "https://marktmorgen.com/r/0123456789abcdef01234567/0?u=x&s=y"],
  ["too long", `https://example.com/${"a".repeat(MAX_SENT_LINK_URL)}`],
  ["not text", 42],
] as [string, unknown][]) is(`refused: ${what}`, readSentLinkTarget(raw).ok, false);

part("The link in the email: the same for every reader, signed");
const path = sentLinkPath(SID, ID, 2, "https://example.com/guide", sign);
is("its path: the store, the email, the number, the address and the signature", path, `/r/${SID}/${ID}/2?u=${encodeURIComponent("https://example.com/guide")}&s=${sign(`${SID}|${ID}|2|https://example.com/guide`)}`);
is("no reader in it", /reader|email|@|mk=/.test(path ?? ""), false);
is("no signature, no link", sentLinkPath(SID, ID, 2, "https://example.com/guide", () => null), null);
is("past the most links in one email, none", sentLinkPath(SID, ID, MAX_SENT_LINKS, "https://example.com/guide", sign), null);
const u = encodeURIComponent("https://example.com/guide");
is("read back", readSentLinkPath(SID, ID, "2", { u: "https://example.com/guide", s: sign(`${SID}|${ID}|2|https://example.com/guide`) }, verify), { ok: true, n: 2, original: "https://example.com/guide" });
is("another address under the same signature: refused (no open redirect)", readSentLinkPath(SID, ID, "2", { u: "https://evil.example/", s: sign(`${SID}|${ID}|2|https://example.com/guide`) }, verify).ok, false);
is("another number: refused", readSentLinkPath(SID, ID, "3", { u: "https://example.com/guide", s: sign(`${SID}|${ID}|2|https://example.com/guide`) }, verify).ok, false);
is("another email: refused", readSentLinkPath(SID, "fedcba9876543210fedcba98", "2", { u: "https://example.com/guide", s: sign(`${SID}|${ID}|2|https://example.com/guide`) }, verify).ok, false);
is("no signature: refused", readSentLinkPath(SID, ID, "2", { u: "https://example.com/guide" }, verify).ok, false);
is("a number that is not one: refused", readSentLinkPath(SID, ID, "02", { u: "https://example.com/guide", s: "x" }, verify).ok, false);
is("another store: refused", readSentLinkPath("bbbbbbbbccccddddeeeeffff00001111", ID, "2", { u: "https://example.com/guide", s: sign(`${SID}|${ID}|2|https://example.com/guide`) }, verify).ok, false);
is("a store id that is not one: no link", sentLinkPath("nope", ID, 2, "https://example.com/guide", sign), null);
is("an encoded address read as the browser gives it", u.length > 0, true);

part("Where it goes");
is("nothing changed: where it was written to go", sentLinkGoesTo("https://example.com/guide", null), "https://example.com/guide");
is("changed: the new address", sentLinkGoesTo("https://example.com/guide", { to: "https://example.com/guide-2", at: 1 }), "https://example.com/guide-2");
is("a kept change that no longer reads: unknown (null), never the old address (review of #3713)", sentLinkGoesTo("https://example.com/guide", { to: "javascript:x", at: 1 }), null);
is("an original that is not an address: unknown (null)", sentLinkGoesTo("javascript:alert(1)", null), null);
is("one of these links through www.: refused, it would loop (review of #3713)", readSentLinkTarget("https://www.marktmorgen.com/r/aaaabbbbccccddddeeeeffff00001111/0123456789abcdef01234567/1?u=x&s=y").ok, false);

part("Changing it, with its history");
const one = changeSentLink([], "https://example.com/a", "https://example.com/b", 100);
is("a change kept with its time", one, { ok: true, history: [{ to: "https://example.com/b", at: 100 }] });
const two = changeSentLink(one.ok ? one.history : [], "https://example.com/a", "https://example.com/c", 200);
is("the newest first", two.ok && two.history.map((h) => h.to), ["https://example.com/c", "https://example.com/b"]);
const back = changeSentLink(two.ok ? two.history : [], "https://example.com/a", "https://example.com/a", 300);
is("back to the original: kept as a change too, so the history says it", back.ok && back.history[0], { to: "https://example.com/a", at: 300 });
let history: { to: string; at: number }[] = [];
for (let i = 0; i < MAX_LINK_CHANGES + 5; i += 1) {
  const next = changeSentLink(history, "https://example.com/a", `https://example.com/${i}`, i);
  if (next.ok) history = next.history;
}
is("a history of at most MAX_LINK_CHANGES", history.length, MAX_LINK_CHANGES);
is("the same address again: nothing to change", changeSentLink(one.ok ? one.history : [], "https://example.com/a", "https://example.com/b", 400), { ok: false, problem: "same" });
is("an address that is not one: refused, saying so", changeSentLink([], "https://example.com/a", "ftp://example.com", 1), { ok: false, problem: "address" });

done();
