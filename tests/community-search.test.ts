/**
 * Searching past the posts: lessons, events and people.
 *
 * A community that could only find posts was behind three of the four rival
 * platforms that document a search at all (checked 30 September 2026). Widening
 * it means the index now holds things that are not all readable by everybody,
 * which is the part worth checking hardest: a lesson title is content, and a
 * search that hands one to somebody who never bought the course has given the
 * course away down the side of a text box.
 *
 * So these run the real index against the real store double, and then check the
 * shape of the thing the page hangs its gate on.
 */
import {
  type SearchKind,
  MAX_INDEXED_WORDS,
  index,
  search,
  searchEverything,
  unindex,
  words,
} from "@/lib/community-search";
import { lessonRef, readLessonRef } from "@/lib/community-index";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const CM = "cm1";

/** What a search finds, as plain ids. */
const found = async (raw: string, kind: SearchKind) => (await search(CM, raw, null, kind)).posts;

async function main(): Promise<void> {
  part("Each kind is its own index");
  redis.clear();
  // The same word in all four. Nothing may leak from one list into another:
  // they are separate keys precisely so a post and a lesson never share a
  // number that means a feed position in one and an hour of the day in the
  // other.
  await index(CM, "post", "p1", 7, ["The pricing thread"]);
  await index(CM, "lesson", lessonRef("prod1", "les1"), 99_999, ["Pricing your offer"]);
  await index(CM, "event", "ev1", 1_760_000_000, ["Pricing workshop"]);
  await index(CM, "member", "mem1", 1_700_000_000, ["Pricing Pete", "pricingpete"]);

  is("a post is found among posts", await found("pricing", "post"), ["p1"]);
  is("a lesson among lessons", await found("pricing", "lesson"), ["prod1.les1"]);
  is("an event among events", await found("pricing", "event"), ["ev1"]);
  is("a person among people", await found("pricing", "member"), ["mem1"]);
  is("and a post is not a lesson", (await found("pricing", "lesson")).includes("p1"), false);

  part("Every kind at once, with how many matched");
  const all = await searchEverything(CM, "pricing");
  is(
    "one of each, counted",
    { post: all.post?.total, lesson: all.lesson?.total, event: all.event?.total, member: all.member?.total },
    { post: 1, lesson: 1, event: 1, member: 1 },
  );
  const none = await searchEverything(CM, "quinoa");
  is("a word nobody wrote finds nothing anywhere", [none.post?.total, none.lesson?.total, none.event?.total, none.member?.total], [0, 0, 0, 0]);

  part("The count is the whole match, not the page");
  redis.clear();
  for (let i = 1; i <= 25; i += 1) await index(CM, "post", `p${i}`, i, ["onboarding"]);
  const paged = await search(CM, "onboarding", null, "post");
  is("a page holds twenty", paged.posts.length, 20);
  is("and says there are twenty-five", paged.total, 25);
  is("with a cursor to the rest", paged.next, 6);
  const rest = await search(CM, "onboarding", paged.next, "post");
  is("the rest is five", rest.posts.length, 5);
  is("and nothing repeats", new Set([...paged.posts, ...rest.posts]).size, 25);

  part("Two words mean both, in every kind");
  redis.clear();
  await index(CM, "lesson", lessonRef("p", "a"), 3, ["Refund policy"]);
  await index(CM, "lesson", lessonRef("p", "b"), 2, ["Refund requests"]);
  await index(CM, "lesson", lessonRef("p", "c"), 1, ["Policy on late work"]);
  is("both words", await found("refund policy", "lesson"), ["p.a"]);
  is("one word finds all that hold it", (await found("refund", "lesson")).sort(), ["p.a", "p.b"]);
  is("and the count follows the intersection", (await search(CM, "refund policy", null, "lesson")).total, 1);

  part("A thing that changes, and a thing that goes");
  redis.clear();
  await index(CM, "event", "ev1", 100, ["Office hours"]);
  is("found by its first title", await found("office", "event"), ["ev1"]);
  await index(CM, "event", "ev1", 100, ["Group coaching"]);
  is("the old words no longer find it", await found("office", "event"), []);
  is("the new ones do", await found("coaching", "event"), ["ev1"]);
  await unindex(CM, "event", "ev1");
  is("and once it is gone it is gone", await found("coaching", "event"), []);

  part("A thing that only moved");
  redis.clear();
  await index(CM, "event", "ev1", 100, ["Live call"]);
  await index(CM, "event", "ev2", 200, ["Live call"]);
  is("the later one first", await found("live", "event"), ["ev2", "ev1"]);
  // Put back an hour: the words did not change, and the order still has to.
  // The first version of this wrote nothing when only the score moved, and an
  // event moved to next month stayed filed under last month for ever.
  await index(CM, "event", "ev1", 300, ["Live call"]);
  is("moving one reorders them", await found("live", "event"), ["ev1", "ev2"]);

  part("Lessons read in the order a student meets them");
  redis.clear();
  // The score counts down from a ceiling, so the first lesson comes back first.
  await index(CM, "lesson", lessonRef("p", "l1"), 100_000, ["Welcome module one"]);
  await index(CM, "lesson", lessonRef("p", "l2"), 99_999, ["Module one continued"]);
  await index(CM, "lesson", lessonRef("p", "l3"), 99_998, ["Module one wrap up"]);
  is("first lesson first", await found("module", "lesson"), ["p.l1", "p.l2", "p.l3"]);

  part("How a lesson is named, so the gate knows what to ask about");
  is("the product and the lesson, joined", lessonRef("prod123", "abcdefghijkl"), "prod123.abcdefghijkl");
  is("and read back apart", readLessonRef("prod123.abcdefghijkl"), { productId: "prod123", lessonId: "abcdefghijkl" });
  is("nothing before the dot is not one", readLessonRef(".abc"), null);
  is("nothing after it is not one either", readLessonRef("abc."), null);
  is("and neither is a bare id", readLessonRef("abc"), null);

  part("Words are words, whatever kind wrote them");
  is("accents fold", words("Café pricing"), ["cafe", "pricing"]);
  is("a handle is one word", words("@pricingpete"), ["pricingpete"]);
  is("a cap that is high enough never to be met by writing", MAX_INDEXED_WORDS, 600);

  part("A member's own words");
  redis.clear();
  await index(CM, "member", "k1", 1, ["Ana Beatriz", "anabeatriz"]);
  is("found by the name they chose", await found("beatriz", "member"), ["k1"]);
  is("and by the handle others mention them by", await found("anabeatriz", "member"), ["k1"]);
  // Somebody who takes themselves off the list is taken out of here, which is
  // what lib/community-index.ts does from inside the very write that changes
  // the directory, so the two can never disagree.
  await unindex(CM, "member", "k1");
  is("off the list, out of the results", await found("beatriz", "member"), []);

  done();
}

void main();
