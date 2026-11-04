/**
 * The community's word filter and spam check (113 [E2-COMMUNITY-MODERATION],
 * unit 1, lib/community-filter.ts; added 1 November 2026). Checked: the
 * creator's list kept clean and bounded; whole words and phrases matched
 * without caring about capitals or accents, never inside another word; more
 * than two links held; the creator never held; the reason said to the
 * creator, and nothing that teaches a member how to dodge it.
 */
import { FILTER_MAX_LINKS, FILTER_MAX_WORDS, FILTER_MAX_WORD_LENGTH, HELD_FOR_MEMBER, foldText, holdReason, holdWords, readFilterWords } from "@/lib/community-filter";
import { done, is, part } from "./check";

part("The creator's list");
is("folded, each once, blanks and too long ones left out", readFilterWords(["Crypto", " crypto ", "", "Free  MONEY", "x".repeat(FILTER_MAX_WORD_LENGTH + 1), 7, "Café"]), ["crypto", "free money", "cafe"]);
is("typed one a line (any line ending) or with commas", readFilterWords("crypto\r\nfree money, dm me"), ["crypto", "free money", "dm me"]);
is("at most fifty", readFilterWords(Array.from({ length: 80 }, (_, i) => `word${i}`)).length, FILTER_MAX_WORDS);
is("nothing usable: an empty list", [readFilterWords(null), readFilterWords({}), readFilterWords(42)], [[], [], []]);
is("folding", foldText("  CAFÉ\n au  Lait "), "cafe au lait");

part("Words and phrases, whole");
const words = readFilterWords(["crypto", "free money", "spam"]);
is("a listed word, any case", holdReason("Ask me about CRYPTO today", words), { kind: "word", word: "crypto" });
is("a phrase across extra spaces and a line break", holdReason("Get free\n  money here", words), { kind: "word", word: "free money" });
is("with an accent the list did not have", holdReason("Späm is here", readFilterWords(["spam"])), { kind: "word", word: "spam" });
is("never inside another word", [holdReason("I am no spammer", words), holdReason("cryptography class notes", words), holdReason("antispam tips", words)], [null, null, null]);
is("next to punctuation still counts", holdReason("(crypto!)", words), { kind: "word", word: "crypto" });
is("an ordinary post goes up as today", holdReason("Here is my sourdough from this morning.", words), null);
is("an empty list holds nothing by its words", holdReason("crypto crypto", []), null);
is("invisible characters cannot split a word: soft hyphen, word joiner, zero-width space", ["cry\u00adpto", "cry\u2060pto", "cry\u200bpto"].map((t) => holdReason(t, words)?.kind ?? null), ["word", "word", "word"]);
is("a dash, dot or underscore between words reads as a space", ["dm-me now", "dm.me", "DM_ME"].map((t) => holdReason(t, readFilterWords(["dm me"]))?.kind ?? null), ["word", "word", "word"]);
is("an underscore no longer hides a whole word either: crypto_king is crypto king", holdReason("crypto_king", words)?.kind ?? null, "word");
is("ß as ss", holdReason("Straße", readFilterWords(["strasse"]))?.kind ?? null, "word");
is("wide letters and joined letters made plain", [holdReason("ＣＲＹＰＴＯ", words)?.kind ?? null, holdReason("ﬁnance", readFilterWords(["finance"]))?.kind ?? null], ["word", "word"]);
is("in writing with no spaces between words, an entry matches anywhere", [holdReason("これはスパムです", readFilterWords(["スパム"]))?.kind ?? null, holdReason("免费加密货币", readFilterWords(["加密货币"]))?.kind ?? null], ["word", "word"]);
is("entries with symbols match as written, never as a pattern", [holdReason("I love c++ a lot", readFilterWords(["c++"]))?.kind ?? null, holdReason("win $$$ now", readFilterWords(["$$$"]))?.kind ?? null, holdReason("cxx", readFilterWords(["c++"]))], ["word", "word", null]);
is("an emoji entry matches next to a word", holdReason("nice🍆there", readFilterWords(["🍆"]))?.kind ?? null, "word");

part("Links");
is("two links: a conversation, not held", holdReason("See https://a.example and https://b.example", []), null);
is("three: held", holdReason("https://a.example https://b.example https://c.example", []), { kind: "links", count: 3 });
is("the creator and the team are never held, by words or by links", [holdReason("crypto https://a.example https://b.example https://c.example", words, true), holdReason("https://a.example https://b.example https://c.example", [], true)], [null, null]);

part("What each one is told");
is("the creator reads the word", holdWords({ kind: "word", word: "crypto" }), 'Held for you to look at: it uses "crypto", which is on your list of words to check.');
is("or the links, with no claim about what posts usually are", holdWords({ kind: "links", count: 4 }), `Held for you to look at: it has 4 links, more than ${FILTER_MAX_LINKS}, so you can check it is not advertising.`);
is("the member is told it waits for the host, promising no time, and not which rule", [HELD_FOR_MEMBER, /quick|soon|minute|crypto|list|link|filter/i.test(HELD_FOR_MEMBER)], ["Thanks. This is waiting for the community's host to review it before others can see it.", false]);
done();
