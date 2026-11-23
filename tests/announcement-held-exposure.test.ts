/**
 * Board #5285, row #3406 (the coordinator's cost line, ibqho c2c2): the company exposure of community announcements
 * held for a store switched off or a plan without email is a finite figure a store, from the code's own constants
 * (lib/community-mail.ts), whose commands a run and a look are measured by tests/community-announce-wait-retry.test.ts.
 */
import { ANNOUNCEMENTS_HELD_MOST, ANNOUNCEMENT_HELD_DAYS, ANNOUNCEMENT_HELD_ENTER_COMMANDS, ANNOUNCEMENT_HELD_LOOK_OWN_COMMANDS, ANNOUNCEMENT_HELD_RUN_COMMANDS, ANNOUNCEMENT_RETRY_SECONDS } from "@/lib/community-mail";
import { ANNOUNCEMENT_HELD_EXPOSURE, COMMAND, DB_BYTE, announcementHeldStoreExposure } from "./plan-cost-registry";
import { done, is, part } from "./check";

part("The line reads the code's own constants");
is("held at once, days kept, a look's wait", [ANNOUNCEMENT_HELD_EXPOSURE.heldMost, ANNOUNCEMENT_HELD_EXPOSURE.days, ANNOUNCEMENT_HELD_EXPOSURE.looksPerDay], [ANNOUNCEMENTS_HELD_MOST, ANNOUNCEMENT_HELD_DAYS, 86_400 / ANNOUNCEMENT_RETRY_SECONDS]);
is("a run's and a look's commands, the store's and settings' reads counted as 4 more", [ANNOUNCEMENT_HELD_EXPOSURE.runCommands, ANNOUNCEMENT_HELD_EXPOSURE.lookCommands, ANNOUNCEMENT_HELD_EXPOSURE.enterCommands], [ANNOUNCEMENT_HELD_RUN_COMMANDS, ANNOUNCEMENT_HELD_LOOK_OWN_COMMANDS + 4, ANNOUNCEMENT_HELD_ENTER_COMMANDS]);

part("The worst case a store, over the longest hold");
const { commands, usd } = announcementHeldStoreExposure();
is("3 sends x 60 days x (288 runs x 3 + 24 looks x 8) + 3 first holds x 5", commands, 3 * (60 * (288 * 3 + 24 * 8) + 5));
is("priced at a command and a kilobyte each", usd, commands * (COMMAND + 1_024 * DB_BYTE));
is("finite and above zero, never taken as nothing", Number.isFinite(usd) && usd > 0, true);
console.log("ANNOUNCEMENT_HELD_STORE_EXPOSURE", JSON.stringify({ commands, usd: Number(usd.toFixed(6)) }));
done();
