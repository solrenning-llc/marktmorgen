/**
 * Evidence that the automatic community-event announcement ignores the
 * store language. The event page and event emails already format the same
 * time, duration and actions in all seven store languages; the feed post
 * made by the create route must do the same.
 */
import { readFileSync } from "node:fs";
import { communityWords } from "@/lib/buyer-words/community";
import {
  type CommunityEvent,
  announcementText,
  eventAddress,
  eventTimeIn,
  lengthIn,
} from "@/lib/community-events";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const event: CommunityEvent = {
  id: "ev_language_1",
  title: "Bread together",
  about: "Bring your starter and your questions.",
  start: Date.UTC(2027, 4, 20, 18, 30),
  minutes: 45,
  tz: "Europe/Lisbon",
  cap: 20,
  where: "room",
  meet: null,
  room: "https://meet.jit.si/marktmorgen-language-proof",
  link: "",
  only: [],
  replay: null,
  cancelled: false,
  post: "",
  at: 1_800_000_000,
  moves: 0,
  v: 1,
};

const store = (language: LanguageCode) => ({ handle: "harbor-kitchen", language });
const english = announcementText(store("en"), event);

part("Controls the automatic post must preserve");
is("English keeps the existing title", english.title, "Live: Bread together");
is("English keeps the event description", english.text.includes(event.about), true);
is("English keeps the permanent event address", english.text.includes(eventAddress(store("en"), event.id)), true);
is("English keeps the event time and duration", english.text.startsWith(`${eventTimeIn(store("en"), event)}, ${lengthIn(store("en"), event.minutes)}.`), true);
const route = readFileSync("app/api/store/community/events/route.ts", "utf8");
is(
  "the create route writes the generated title and text into the announcement post",
  route.includes("const words = announcementText(store, event)") &&
    route.includes("title: words.title, text: words.text") &&
    route.indexOf("const words = announcementText(store, event)") < route.indexOf("title: words.title, text: words.text"),
  true,
);

part("Every non-English store gets its own event words");
for (const language of LANGUAGE_CODES.filter((code) => code !== "en")) {
  const words = communityWords(language);
  const made = announcementText(store(language), event);
  is(`${language}: the title is not the English Live label`, made.title.startsWith("Live:"), false);
  is(`${language}: the date and time use the store locale`, made.text.startsWith(eventTimeIn(store(language), event)), true);
  is(`${language}: the duration uses the store words`, made.text.includes(lengthIn(store(language), event.minutes)), true);
  is(
    `${language}: the action line is not the English RSVP instruction`,
    made.text.includes("RSVP, add it to your calendar and join here:"),
    false,
  );
  is(`${language}: localized event terms already exist`, [words.liveEventTitle, words.rsvp, words.addToCalendar, words.joinHere].every(Boolean), true);
}

done();
