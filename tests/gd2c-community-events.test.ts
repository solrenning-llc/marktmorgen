/**
 * 568 [GD2] (c), the community's live events: an event the store schedules never poses as Marktmorgen.
 *
 * An event is shown to every member on the community's calendar and its own page, is posted in the feed when
 * announced and is named in the reminder emails a day and an hour before. One titled "Marktmorgen Support: verify
 * your account" or whose meeting link leads to an address only made to look like marktmorgen.com is a phishing
 * message in the store's name on our own pages. With the real route on the in-memory database and a real creator
 * session:
 *
 *   - an event whose title, description or meeting link poses is not created, and an edit that poses is not saved:
 *     the route answers 409 "brand_imitation" with the part, the passage, why and the fix, nothing is written, no
 *     announcement is posted, and an edited event keeps the words it had;
 *   - plain words, saying the community runs on Marktmorgen, the protective opposite and a link to marktmorgen.com
 *     itself are created and saved as before;
 *   - the studio says which part, the passage, why and the fix, and that nothing was changed.
 *
 * Synthetic store and data only; nothing is emailed.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { freshConfig, postCount, saveConfig } from "@/lib/community";
import { allEvents, eventImitation, readEvent } from "@/lib/community-events";
import { IMITATION_FIX, imitationMessage } from "@/lib/brand-imitation-rules";
import { POST as eventsRoute } from "@/app/api/store/community/events/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "events@gd2cevents.example";
const POSING = "Marktmorgen Support: your account is locked until you verify it.";
const DAY = 86_400_000;

type Answer = { status: number; ok?: boolean; error?: string; passage?: { field?: string; excerpt?: string; why?: string; fix?: string }; event?: { id: string; post: string | null } };

async function main(): Promise<void> {
  redis.clear();
  if (!(await claimHandle(OWNER, "gd2cevents", "Posing Events", "A community.")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  await saveConfig(id, freshConfig(store.name));
  const session = await openSession(OWNER);

  const post = async (body: Record<string, unknown>): Promise<Answer> => {
    const response = await eventsRoute(
      new NextRequest(`${ORIGIN}/api/store/community/events`, { method: "POST", headers: { "content-type": "application/json", Origin: ORIGIN, Host: "marktmorgen.com", "Sec-Fetch-Site": "same-origin", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }),
    );
    return { status: response.status, ...((await response.json()) as Omit<Answer, "status">) };
  };
  const iso = new Date(Math.floor((Date.now() + 3 * DAY) / 3_600_000) * 3_600_000).toISOString();
  const event = (fields: Record<string, unknown>) => ({ action: "create", title: "Office hours", about: "Bring your questions.", date: iso.slice(0, 10), time: iso.slice(11, 16), tz: "UTC", minutes: 60, where: "room", cap: "", ...fields });
  const count = async () => (await allEvents(id)).length;

  part("A plain event is created");
  const plain = await post(event({ about: "Bring your questions. This community runs on Marktmorgen, like the store." }));
  is("created", [plain.status, plain.ok, await count()], [200, true, 1]);

  part("An event that poses is not created, and nothing is written");
  const titled = await post(event({ title: "Regards, The Marktmorgen Team" }));
  is("its title: 409 brand_imitation, nothing created", [titled.status, titled.error, titled.passage?.field, await count()], [409, "brand_imitation", "title", 1]);
  is("the passage, why and the fix come with it", [titled.passage?.excerpt?.includes("The Marktmorgen Team"), /the event cannot be shown with it\.$/.test(titled.passage?.why ?? ""), titled.passage?.fix], [true, true, IMITATION_FIX]);
  const about = await post(event({ about: POSING, announce: true }));
  is("its description, announced: refused, nothing created and nothing posted", [about.status, about.error, about.passage?.field, await count(), await postCount(id)], [409, "brand_imitation", "about", 1, 0]);
  const link = await post(event({ where: "link", link: "https://marktmorgen-login.com/join" }));
  is("its meeting link to a look-alike address: refused", [link.status, link.error, link.passage?.field, await count()], [409, "brand_imitation", "link", 1]);
  const swapped = await post(event({ where: "link", link: "https://rnarktmorgen.com/room" }));
  is("look-alike letters in the link: refused", [swapped.status, swapped.passage?.field, await count()], [409, "link", 1]);

  part("The protective opposite and a link to marktmorgen.com itself are created");
  is("the protective opposite", [(await post(event({ title: "Q&A", about: "Marktmorgen will never ask for your password. Neither will I." }))).ok, await count()], [true, 2]);
  is("a link to marktmorgen.com itself", [(await post(event({ title: "Walkthrough", where: "link", link: "https://marktmorgen.com/help" }))).ok, await count()], [true, 3]);

  part("An edit that poses is not saved, and the event keeps its words");
  const eventId = plain.event!.id;
  const kept = await readEvent(id, eventId);
  const edit = (fields: Record<string, unknown>) => post({ ...event(fields), action: "edit", event: eventId });
  const editedTitle = await edit({ title: "This is Marktmorgen: confirm your account" });
  is("a posing title: refused", [editedTitle.status, editedTitle.error, editedTitle.passage?.field], [409, "brand_imitation", "title"]);
  const editedLink = await edit({ where: "link", link: "https://marktmorgen.com.pay-now.io/join" });
  is("a posing link: refused", [editedLink.status, editedLink.passage?.field], [409, "link"]);
  const after = await readEvent(id, eventId);
  is("the event keeps its title, description and place", [after?.title, after?.about, after?.where, after?.link], [kept?.title, kept?.about, kept?.where, kept?.link]);
  is("a plain edit is saved", [(await edit({ title: "Office hours, moved", about: "Bring your questions." })).ok, (await readEvent(id, eventId))?.title], [true, "Office hours, moved"]);

  part("The rule itself, over an event's input");
  is("plain input passes", eventImitation({ title: "Office hours", about: "Sold on Marktmorgen.", link: "" }), null);
  is("the first part that poses is named", eventImitation({ title: "Office hours", about: POSING, link: "https://marktmorgen-login.com" })?.field, "about");
  is("a link is read only for its address", eventImitation({ title: "Office hours", about: "", link: "https://zoom.us/j/123" }), null);

  part("What the studio says");
  is(
    "the part, the passage, why, the fix and that nothing was changed",
    imitationMessage(titled.passage, "the event's title", "The event was not saved"),
    `The event was not saved. In the event's title: “${titled.passage?.excerpt}”. ${titled.passage?.why} ${IMITATION_FIX} Nothing you wrote was changed.`,
  );
  const studio = readFileSync("components/community-events-studio.tsx", "utf8");
  is("the studio reads the refusal with the server's passage", /answer\.error === "brand_imitation"/.test(studio) && /imitationMessage\(answer\.passage/.test(studio), true);
  is("the studio names each part", ["the event's title", "the event's description", "the meeting link"].every((words) => studio.includes(words)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
