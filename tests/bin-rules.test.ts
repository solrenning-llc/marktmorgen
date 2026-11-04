/**
 * The 30-day bin (417 [CC1], unit 1, lib/bin-rules.ts; added 1 November
 * 2026). Checked: thirty days to the millisecond; the purge only after
 * them; a restore refused once they are over, when a right to erasure took
 * what it held, when the plan is full, or when room cannot be read; each
 * kind comes back stopped where it would act outside the studio by itself;
 * what a product takes back with it, and what is left to the creator.
 */
import { BIN_DAYS, PRODUCT_BUYERS_WORDS, PRODUCT_LINKS, REFUSED_WORDS, RESTORED_AS, binLine, commentAlone, keptOutWords, purgeDue, restorableChildren, restoreBy, restoreRefusal, spaceOpenToMembers, type BinKind } from "@/lib/bin-rules";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const T = Date.UTC(2026, 10, 1, 12);

part("Thirty days");
is("thirty", BIN_DAYS, 30);
is("to the millisecond", restoreBy({ kind: "product", deletedAt: T }), T + 30 * DAY);
is("the purge waits for them", [purgeDue({ kind: "product", deletedAt: T }, T + 30 * DAY - 1), purgeDue({ kind: "product", deletedAt: T }, T + 30 * DAY)], [false, true]);
is("the line the creator reads", [binLine({ kind: "page", deletedAt: T }, T), binLine({ kind: "page", deletedAt: T }, T + 29.5 * DAY), binLine({ kind: "page", deletedAt: T }, T + 30 * DAY - 1), binLine({ kind: "page", deletedAt: T }, T + 31 * DAY)], ["Deleted for good on December 1 (UTC), in 30 days.", "Deleted for good on December 1 (UTC), in 1 day.", "Deleted for good on December 1 (UTC), in 1 day.", "Deleted for good today."]);

part("Coming back, or not");
const entry = { kind: "product" as const, deletedAt: T };
is("inside the days, with room: it comes back", restoreRefusal(entry, { erased: false, room: true }, T + DAY), null);
is("after them: expired", restoreRefusal(entry, { erased: false, room: true }, T + 30 * DAY), "expired");
is("taken by a right to erasure: never, whatever else", [restoreRefusal(entry, { erased: true, room: true }, T + DAY), restoreRefusal(entry, { erased: true, room: null }, T + DAY)], ["erased", "erased"]);
is("the plan full: refused, said plainly", [restoreRefusal(entry, { erased: false, room: false }, T + DAY), REFUSED_WORDS.full.startsWith("Your plan has no room")], ["full", true]);
is("room that could not be read: nothing changes on a guess", restoreRefusal(entry, { erased: false, room: null }, T + DAY), "unknown");
is("deleted this very moment: it can come back", restoreRefusal({ kind: "page", deletedAt: T }, { erased: false, room: true }, T), null);
is("a date that cannot be right: nothing changes", [restoreRefusal({ kind: "page", deletedAt: 0 }, { erased: false, room: true }, T), restoreRefusal({ kind: "page", deletedAt: T + DAY }, { erased: false, room: true }, T), restoreRefusal({ kind: "page", deletedAt: 1.5 }, { erased: false, room: true }, T)], ["unknown", "unknown", "unknown"]);

part("Each kind comes back stopped where it would act by itself");
const kinds: BinKind[] = ["product", "page", "emailDraft", "sequence", "space", "post", "comment"];
is("every kind has a state and a sentence, and no other kind is there", [kinds.every((k) => RESTORED_AS[k].state && RESTORED_AS[k].words.length > 20), Object.keys(RESTORED_AS).sort()], [true, [...kinds].sort()]);
is("nothing that sells, publishes or sends comes back doing it", [RESTORED_AS.product.state, RESTORED_AS.page.state, RESTORED_AS.emailDraft.state, RESTORED_AS.sequence.state], ["hidden", "unpublished", "draft", "paused"]);
is("a sequence: nobody put back, no missed step sent", RESTORED_AS.sequence.words.includes("with nobody in it") && RESTORED_AS.sequence.words.includes("No step that was due"), true);
is("community things come back as they were, so a post the creator hid stays hidden, and nobody is told again", [RESTORED_AS.space.state, RESTORED_AS.post.state, RESTORED_AS.comment.state, [RESTORED_AS.space.words, RESTORED_AS.post.words, RESTORED_AS.comment.words].every((w) => w.includes("Nobody is told again."))], ["asItWas", "asItWas", "asItWas", true]);
is("a sequence says people who went through it could start it again", RESTORED_AS.sequence.words.includes("People who went through it before could start it again"), true);

part("Others' posts and comments, one by one");
const kids = [{ id: "a", erased: false }, { id: "b", erased: true }, { id: "c", erased: false }];
is("what an erasure took stays out; the rest comes back", [restorableChildren(kids).back.map((k) => k.id), restorableChildren(kids).keptOut], [["a", "c"], 1]);
is("and the creator is told how many", [keptOutWords(1), keptOutWords(3), keptOutWords(0)], ["One post or comment stays deleted: someone asked for their data to be deleted.", "3 posts or comments stay deleted: someone asked for their data to be deleted.", ""]);
is("a comment whose post is in the bin comes back only with it", [commentAlone(true), commentAlone(false)], [false, true]);
is("a space whose access named products that are gone is closed to members", [spaceOpenToMembers(["p1"], new Set(["p1"])), spaceOpenToMembers(["p1", "p2"], new Set(["p1"])), spaceOpenToMembers([], new Set())], [true, false, true]);

part("What a product takes back with it");
is("its places in sections and collections that still exist", PRODUCT_LINKS.back, ["sections", "collections"]);
is("never by itself, and listed: the news line, pages' buttons, bundles, a collection its deleting emptied, a section that started at it", PRODUCT_LINKS.listed, ["announcement", "sitePages", "bundles", "emptiedCollections", "sectionStarts"]);
is("its buyers: no access lost, nothing canceled, no charge or email on a restore", PRODUCT_BUYERS_WORDS, "Nobody who bought it loses access, and no subscription to it is canceled. Putting it back starts no charge and sends no email.");
done();
