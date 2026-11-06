/**
 * How soon Discord roles go, said as the code does it (531 [VP1] review,
 * 1 November 2026). The next check is CHECK_HOURS after the last one
 * (lib/discord-store.ts, keepMember), run by a job every half hour
 * (vercel.json), and a person whose purchases Stripe could not read is kept
 * and checked CHECK_HOURS later again (lib/discord-access.ts). So no page
 * promises the roles go "within" a time: they go at the next check, about
 * every CHECK_HOURS, and nothing is taken while Stripe cannot be reached.
 */
import { readFileSync } from "node:fs";
import { CHECK_HOURS } from "@/lib/discord-rules";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");

part("What the code does");
is("the next check is CHECK_HOURS after the last", read("lib/discord-store.ts").includes('["ZADD", DUE_KEY, Math.floor(now / 1000) + CHECK_HOURS * 3_600, `${sid}|${userId}`]'), true);
is("run by a job every half hour", /"path": "\/api\/cron\/discord",\s*"schedule": "17,47 \* \* \* \*"/.test(read("vercel.json")), true);
is("Stripe not answering: kept, and checked again later", /Stripe could not be asked: nothing is taken on a guess\.[\s\S]{0,200}await keepMember\(room, sid, userId, member, now\);/.test(read("lib/discord-access.ts")), true);
is("six hours", CHECK_HOURS, 6);
is("Discord refusing a role: kept, and tried again at the next check", /if \(done === "failed"\) failed = true;[\s\S]{0,40}if \(failed\) \{\s*await keepMember\(room, sid, userId, member, now\);/.test(read("lib/discord-access.ts")), true);
is("only a refund in full takes access away", read("lib/community-access.ts").includes("refundedInFull"), true);

part("What the pages say");
const studio = read("app/studio/discord/page.tsx");
const feature = read("lib/feature-pages.ts");
const help = read("lib/help-content.ts");
is("the studio: at the next check, about every CHECK_HOURS, nothing while Stripe cannot be reached", studio.includes("a purchase is refunded in full, the roles are taken back at the next check, which comes about every ${CHECK_HOURS} hours. While Stripe or Discord cannot be reached, or Discord will not let the bot remove a role, nothing is taken until it can be."), true);
is("the feature page and the help center: about every six hours", [feature.includes("checked again about every six hours against your own Stripe account"), feature.includes("Roles are taken back at the next check, which comes about every six hours, not in the same second. While Stripe or Discord cannot be reached, or Discord will not let the bot remove a role, nothing is taken until it can be."), help.includes("Everyone is checked again about every six hours against your Stripe account"), feature.includes("keep the Marktmorgen role above the roles it gives")], [true, true, true, true]);
const buyer = read("lib/buyer-words/discord.ts");
is("the buyers' words, in every language: at the next check, a refund in full, no time", [(buyer.match(/keepNote:/g) ?? []).length, /within a few hours|en pocas horas|en quelques heures|innerhalb weniger Stunden|entro poche ore|binnen een paar uur|em poucas horas/.test(buyer), buyer.includes("refunded in full, they are taken back at the next check.")], [7, false, true]);
const discordBlock = feature.slice(feature.indexOf('slug: "discord-access"'), feature.indexOf("slug:", feature.indexOf('slug: "discord-access"') + 10));
const helpDiscord = help.slice(help.indexOf("If your buyers already gather in a Discord server"), help.indexOf("If your buyers already gather in a Discord server") + 900);
is("no Discord sentence says a refund that is not in full takes roles away", [studio, discordBlock, helpDiscord].every((t) => !/refunded(?! in full)/.test(t)), true);
is("the studio's list of people: about every CHECK_HOURS", read("components/discord-studio.tsx").includes("checked again about every ${limits.hours} hours."), true);
for (const [file, text] of [["components/discord-studio.tsx", read("components/discord-studio.tsx")], ["app/studio/discord/page.tsx", studio], ["lib/feature-pages.ts", feature], ["lib/help-content.ts", help], ["lib/discord-rules.ts", read("lib/discord-rules.ts")]] as const) {
  is(`${file}: no "within" a time for roles, and no flat "every six hours" for the checks`, [/taken back within|within (six|\$\{CHECK_HOURS\}) hours|within CHECK_HOURS/.test(text), /checked again every (six|\$\{limits\.hours\}) hours/.test(text)], [false, false]);
}
done();
