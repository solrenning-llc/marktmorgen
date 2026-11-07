/**
 * The studio's alert email page (app/studio/notifications) and its panel
 * (components/notify-prefs-panel.tsx), rendered with the real session,
 * store and stop-link reading; only the request context and the studio's
 * header are stand-ins (tests/test-config.mjs). From Claude 3's independent
 * review of #3013 (its three proofs are folded in here). Checked:
 *
 *   - the weekly email's stop link read as on, off, or unknown: an unknown
 *     reading (the SISMEMBER fails) is never drawn as "not stopped". The page
 *     says it could not check, still offers the way to start the emails again
 *     (SREM is idempotent), and the save message does not claim the emails
 *     follow the choices while the stop link may hold;
 *   - after "Start these emails again" succeeds, the button goes away, so
 *     focus is moved on purpose to the heading that stays (WCAG 2.4.3);
 *   - each box's description is given once, by aria-describedby, and is not
 *     also inside its label, so it is not read twice (WCAG 4.1.2 / 1.3.1).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StudioNotificationsPage from "@/app/studio/notifications/page";
import * as panelModule from "@/components/notify-prefs-panel";
import { claimHandle, ensureStatsId, ensureStoreId } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { setWeeklyOff } from "@/lib/stats-report";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const { NotifyPrefsPanel } = panelModule;
const savedText = (panelModule as { savedText?: (stopped: boolean | null) => string }).savedText;
const RESTART = "Start these emails again";
const UNKNOWN = /could not check whether the stop link/i;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "notify-page-owner@example.com";
  await claimHandle(OWNER, "notifypageharbor", "Notify Page Harbor", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  cookieValues.set(SESSION_COOKIE, await openSession(OWNER));
  const draw = async () => renderToStaticMarkup(await StudioNotificationsPage({ searchParams: Promise.resolve({}) }));

  part("The weekly stop link: on, off, or unknown");
  const running = await draw();
  is("known off: no stop notice, no restart button", [running.includes(RESTART), UNKNOWN.test(running)], [false, false]);
  await setWeeklyOff("notifypageharbor", true);
  const stopped = await draw();
  is("known on: said, with the way to undo it", [stopped.includes(RESTART), stopped.includes("All of these alert emails are stopped")], [true, true]);

  // Only the stop link's SISMEMBER fails; every other read is real (Claude 3's proof).
  const real = redis.pipeline.bind(redis);
  (redis as { pipeline: typeof redis.pipeline }).pipeline = (async (commands: unknown[][]) => {
    if (commands.some((c) => c[0] === "SISMEMBER" && String(c[1]).includes("weekly"))) throw new Error("Redis request failed with status 503");
    return real(commands as never);
  }) as typeof redis.pipeline;
  let unknown = "";
  try {
    unknown = await draw();
  } catch (error) {
    unknown = `threw: ${String(error)}`;
  } finally {
    (redis as { pipeline: typeof redis.pipeline }).pipeline = real;
  }
  is("unknown: the page still opens", unknown.startsWith("threw:") ? unknown : "opened", "opened");
  is("unknown: it says it could not check the stop link", UNKNOWN.test(unknown), true);
  is("unknown: it still offers the way to start them again", unknown.includes(RESTART), true);
  is("unknown: it does not say they are stopped for sure", unknown.includes("All of these alert emails are stopped"), false);

  part("What a save says, for each reading of the stop link");
  is("the save message is one function of the reading", typeof savedText, "function");
  if (savedText) {
    is("off: the emails follow the choices", savedText(false), "Saved. Your alert emails follow these choices from now on.");
    is("on: they stay stopped until started again", /stay stopped/.test(savedText(true)), true);
    is("unknown: never claims the emails follow the choices", /follow these choices from now on/.test(savedText(null)), false);
    is("unknown: says the stop link may still hold", /stop link/.test(savedText(null)), true);
  }

  part("Focus after a restart (Claude 3's proof, finding 2)");
  const panel = readFileSync("components/notify-prefs-panel.tsx", "utf8");
  const start = panel.indexOf("async function restart()");
  const restart = panel.slice(start, panel.indexOf("return (", start));
  is("restart() removes the stop block on success", restart.includes("setStopped(false)"), true);
  is("and moves focus on purpose, in the same success path", /setStopped\(false\);[\s\S]*?\.focus\(\)/.test(restart), true);
  const drawn = renderToStaticMarkup(createElement(NotifyPrefsPanel, { off: [], stopped: true }));
  is("the target stays mounted and can take focus: the 'Alerts you choose' heading", /<h2 id="notify-choose"[^>]*tabindex="-1"/.test(drawn), true);

  part("Each box's description, read once (Claude 3's proof, finding 3)");
  const html = renderToStaticMarkup(createElement(NotifyPrefsPanel, { off: [], stopped: false }));
  for (const id of ["traffic", "conversion", "refunds", "goal-pace", "goal-reached", "quiet-sales"]) {
    const label = new RegExp(`<label[^>]*for="notify-${id}"[^>]*>([\\s\\S]*?)</label>`).exec(html)?.[1] ?? "";
    is(`${id}: the box points at its description`, html.includes(`aria-describedby="notify-${id}-text"`), true);
    is(`${id}: the description is given once`, html.split(`id="notify-${id}-text"`).length - 1, 1);
    is(`${id}: and not inside the label, so not in the name too`, [label.length > 0, label.includes(`id="notify-${id}-text"`)], [true, false]);
  }
  is("the labels keep their 44 px target", /<label class="[^"]*min-h-11[^"]*" for="notify-traffic"/.test(html), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
