/**
 * 286 [SX2], unit 1: the rules of the AI topic ideas for a community
 * (lib/topic-ideas-rules.ts). Only the store's own content is read: its
 * published courses, members' posts nobody has answered and the events it
 * has coming; addresses, phone numbers and links taken out, never who wrote
 * a post. The model only proposes: an idea is kept only when every word of
 * it that carries meaning comes from the sources it names, with no figure,
 * link or deal word. At most five, at most once a week, and an idea whose
 * sources are gone (a post deleted or hidden, an event canceled) is dropped.
 */
import { readFileSync } from "node:fs";
import {
  IDEAS_REFRESH_SECONDS,
  MAX_IDEAS,
  MAX_IDEA_INPUT_BYTES,
  MAX_IDEA_TITLE,
  MIN_IDEA_SOURCES,
  QUESTION_WINDOW_SECONDS,
  type IdeaCourse,
  type IdeaEvent,
  type IdeaPost,
  ideaSources,
  ideasStillShown,
  mayMakeIdeas,
  readIdeas,
} from "@/lib/topic-ideas-rules";
import { done, is, part } from "./check";

const NOW_S = 2_000_000_000;
const NOW_MS = NOW_S * 1000;
const DAY_S = 86_400;

const course = (title: string, lessons: string[], draft = false): IdeaCourse => ({ title, lessons, draft });
const post = (over: Partial<IdeaPost> = {}): IdeaPost => ({ a: "m1", title: "How do I mix greens?", text: "Mine turn muddy.", at: NOW_S - DAY_S, kind: "post", hid: false, replies: 0, ...over });
const event = (over: Partial<IdeaEvent> = {}): IdeaEvent => ({ title: "Live glaze demo", start: NOW_MS + 3 * DAY_S * 1000, cancelled: false, ...over });

part("What is read");
const sources = ideaSources(
  {
    courses: [course("Watercolor basics", ["Mixing greens", "Wet on wet"]), course("Secret draft", ["Hidden lesson"], true)],
    posts: [
      post(),
      post({ title: "Answered one", replies: 2 }),
      post({ title: "Hidden one", hid: true }),
      post({ title: "From the creator", a: "CREATOR" }),
      post({ title: "An announcement", kind: "announcement" }),
      post({ title: "Old question", at: NOW_S - QUESTION_WINDOW_SECONDS - 1 }),
      post({ title: "Reach me", text: "at ana@example.com or www.ana.example or +" + "1 555 010 2030" }),
    ],
    events: [event(), event({ title: "Canceled call", cancelled: true }), event({ title: "Past call", start: NOW_MS - 1000 }), event({ title: "Too far ahead", start: NOW_MS + 60 * DAY_S * 1000 })],
  },
  NOW_MS,
);
is("events coming first, then unanswered members' posts newest first, then published courses, numbered", sources, [
  { id: 1, kind: "event", text: "Live glaze demo" },
  { id: 2, kind: "question", text: "How do I mix greens? Mine turn muddy." },
  { id: 3, kind: "question", text: "Reach me. at [email] or [link] or [number]" },
  { id: 4, kind: "course", text: "Watercolor basics: Mixing greens; Wet on wet" },
]);
is("never who wrote a post", JSON.stringify(sources).includes("m1"), false);
is("a post with nothing left once cleaned is not read", ideaSources({ courses: [], posts: [post({ title: "", text: "www.example.com" })], events: [] }, NOW_MS), []);
const many = ideaSources({ courses: Array.from({ length: 200 }, (_, i) => course(`Course ${"x".repeat(250)} ${i}`, ["A lesson"])), posts: [], events: [] }, NOW_MS);
is("the whole input stays under its byte cap", Buffer.byteLength(many.map((s) => s.text).join("\n")) <= MAX_IDEA_INPUT_BYTES && many.length > 0, true);
is("each source is cut at whole characters", ideaSources({ courses: [course("🎨".repeat(400), [])], posts: [], events: [] }, NOW_MS)[0].text, "🎨".repeat(300));
is("an unknown shape reads as nothing, never as content", ideaSources({ courses: [null as never, { title: 4 } as never], posts: [undefined as never], events: [{} as never] }, NOW_MS), []);

part("When");
const three = sources.slice(0, MIN_IDEA_SOURCES);
is("enough sources, never made: may", mayMakeIdeas(three, 0, NOW_S), true);
is("too few: may not", mayMakeIdeas(three.slice(1), 0, NOW_S), false);
is("at most once a week", [mayMakeIdeas(three, NOW_S, NOW_S + IDEAS_REFRESH_SECONDS - 1), mayMakeIdeas(three, NOW_S, NOW_S + IDEAS_REFRESH_SECONDS)], [false, true]);
is("a last time in the future (a clock moved back) may not", mayMakeIdeas(three, NOW_S + 10, NOW_S), false);

part("The model only proposes");
const ideas = readIdeas(
  {
    ideas: [
      { title: "Tips for mixing greens", from: [2, 4] },
      { title: "Questions before the live glaze demo", from: [1] },
      { title: "Get 20% off the course", from: [4] },
      { title: "Visit www.example.com", from: [4] },
      { title: "Why acrylic beats oil", from: [4] },
      { title: "Tips for mixing greens", from: [2] },
      { title: "Wet on wet: your first try", from: [] },
      { title: "Wet on wet: your first try", from: [99] },
      { title: "Wet on wet: your first try", from: [4] },
      { title: "x".repeat(MAX_IDEA_TITLE + 1), from: [4] },
      { title: "Limited spots: join now", from: [1] },
      { title: "Share your muddy greens", from: [2] },
      { title: "One more about greens", from: [2] },
    ],
  },
  sources,
);
is("kept: held to their own sources, no figure, link or deal word, once each, at most five", ideas, [
  { title: "Tips for mixing greens", from: [2, 4] },
  { title: "Questions before the live glaze demo", from: [1] },
  { title: "Wet on wet: your first try", from: [4] },
  { title: "Share your muddy greens", from: [2] },
]);
is("never more than the cap", readIdeas({ ideas: Array.from({ length: 20 }, (_, i) => ({ title: ["Mixing greens", "Wet on wet", "Watercolor basics", "Live glaze demo", "Muddy greens", "Mix greens", "Glaze demo"][i % 7], from: [1, 2, 4] })) }, sources).length <= MAX_IDEAS, true);
is("an idea of framing words only says nothing the sources said, and is refused", readIdeas({ ideas: [{ title: "Tips", from: [2] }, { title: "Your questions", from: [2] }, { title: "Share your first try", from: [4] }] }, sources), []);
is("a word from a source it does not name is refused", readIdeas({ ideas: [{ title: "Live glaze demo", from: [4] }] }, sources), []);
is("an unknown answer reads as no idea", [readIdeas(null, sources), readIdeas("ideas", sources), readIdeas({ ideas: "x" }, sources), readIdeas({ ideas: [null, 4, { title: 3, from: [1] }] }, sources)], [[], [], [], []]);
is("an address or handle in a title is refused", readIdeas({ ideas: [{ title: "Ask @ana about greens", from: [2] }] }, sources), []);

part("Gone sources take their ideas with them");
const kept = [
  { title: "Tips for mixing greens", from: [2, 4] },
  { title: "Questions before the live glaze demo", from: [1] },
];
is("all still shown: all kept", ideasStillShown(kept, sources, sources), kept);
const later = ideaSources({ courses: [course("Watercolor basics", ["Mixing greens", "Wet on wet"])], posts: [post({ replies: 0 })], events: [event({ cancelled: true })] }, NOW_MS);
is("an event canceled since drops the idea made from it", ideasStillShown(kept, sources, later), [kept[0]]);
const deleted = ideaSources({ courses: [course("Watercolor basics", ["Mixing greens", "Wet on wet"])], posts: [], events: [event()] }, NOW_MS);
is("a post deleted or hidden since drops the idea made from it", ideasStillShown(kept, sources, deleted), [kept[1]]);
is("an idea naming a source never sent is dropped", ideasStillShown([{ title: "Wet on wet", from: [42] }], sources, sources), []);

part("Nothing is asked, read or written here");
const src = readFileSync("lib/topic-ideas-rules.ts", "utf8");
is("no model call, store read or network", /from "@\/lib\/(redis|ai|anthropic|model|store|community)"|fetch\(|messages\.create/.test(src), false);

done();
