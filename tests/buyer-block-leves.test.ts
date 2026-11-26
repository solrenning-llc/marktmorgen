/**
 * The LOW findings left open on #3839 (Claude 7, 6889878018, and the earlier reviews it lists), each with a test:
 *   - a reason with lone surrogates is kept within BLOCK_ENTRY_BYTES (JSON writes a lone surrogate as six bytes);
 *   - a store with no `sid` has no block list, so it blocks nobody: it never refuses every visitor as "unknown";
 *   - an address's "+tag" spelling is the same person: blocking one blocks the other;
 *   - the chat's refusal does not suggest a short pause ("right now"), and points to the order page's report, which a
 *     block never stops, in every language the chat speaks.
 * Synthetic stores, the memory Redis.
 */
import { BLOCK_ENTRY_BYTES, blockReason, blockedState, personMark } from "@/lib/buyer-block";
import { dataBytes } from "@/lib/store-data-rules";
import { chatWords } from "@/lib/buyer-words/chat";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

part("Lone surrogates never make an entry larger than its room");
const lone = "\ud800".repeat(500);
const kept = blockReason(lone);
const entry = dataBytes(["0".repeat(64), JSON.stringify({ r: kept, at: 8.64e15 })]);
is("a reason of lone surrogates fits BLOCK_ENTRY_BYTES", entry <= BLOCK_ENTRY_BYTES, true);
is("and is well formed", kept.isWellFormed(), true);
const split = blockReason(`${"a".repeat(199)}😀`);
is("a pair cut at the most is not left half", split.isWellFormed(), true);

part("A store with no sid blocks nobody");
void (async () => {
  is("no sid: not blocked", await blockedState({ sid: undefined } as never, "anyone@example.com"), { blocked: false });

  part("An address's +tag spelling is the same person");
  is("x+tag@ and x@ have one mark", personMark("rude+again@example.com"), personMark("rude@example.com"));
  is("any tag", personMark("Rude+Other@Example.com"), personMark("rude@example.com"));
  is("another person is another mark", personMark("kind@example.com") === personMark("rude@example.com"), false);

  part("The chat's refusal is honest and points to what stays open");
  for (const language of LANGUAGE_CODES) {
    const said = chatWords(language).notices.closed;
    is(`${language}: no "right now" or its translation`, /right now|ahora mismo|pour le moment|gerade|in questo momento|\bnu\b|neste momento/i.test(said), false);
  }
  is("en: points to the report on the order page", /report a problem/i.test(chatWords("en").notices.closed), true);
  done();
})();
