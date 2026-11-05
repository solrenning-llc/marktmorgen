/**
 * The right keyboard on a phone in a store's profiles (487 [IT4], item 2,
 * the difference after the audit of 1 November 2026; docs/ease-patterns-audit.md):
 * the WhatsApp number opens the phone keyboard and may be filled in with the
 * person's own number; the email row offers the person's own address; a
 * handle or a link is not filled in.
 */
import { readFileSync } from "node:fs";
import { profileKeyboard } from "@/components/socials-editor";
import { SOCIAL_NETWORKS, socialUrl } from "@/lib/store-socials";
import { done, is } from "./check";

is("WhatsApp: the phone keyboard and the person's own number, in its row's own section", profileKeyboard("whatsapp", 3), { type: "text", inputMode: "tel", autoComplete: "section-profile-3 tel" });
is("email: the email keyboard and the person's own address, in its row's own section", profileKeyboard("email", 5), { type: "email", autoComplete: "section-profile-5 email" });
is("two rows never share a section, so one suggestion never fills the other", profileKeyboard("whatsapp", 1).autoComplete.split(" ")[0] !== profileKeyboard("email", 2).autoComplete.split(" ")[0], true);
is("every other network: a handle or a link, nothing filled in", SOCIAL_NETWORKS.filter((n) => n !== "email" && n !== "whatsapp").every((n) => JSON.stringify(profileKeyboard(n, 0)) === JSON.stringify({ type: "text", autoComplete: "off" })), true);
const source = readFileSync("components/socials-editor.tsx", "utf8");
const field = source.slice(source.indexOf("<input\n                    id={`${id}-value`}"), source.indexOf("/>", source.indexOf("id={`${id}-value`}")));
is("the profile's field takes them", [field.includes('type={row.network === "email" ? "email" : "text"}'), field.includes("inputMode={profileKeyboard(row.network, row.key).inputMode}"), field.includes("autoComplete={profileKeyboard(row.network, row.key).autoComplete}")], [true, true, true]);
is("its type agrees with the function for every network", SOCIAL_NETWORKS.every((n) => profileKeyboard(n, 0).type === (n === "email" ? "email" : "text")), true);
is("the phone keyboard only picks keys: a pasted wa.me link is still taken", [socialUrl("whatsapp", "wa.me/" + "15550100000"), socialUrl("whatsapp", "https://wa.me/" + "15550100000")], ["https://wa.me/15550100000", "https://wa.me/15550100000"]);
done();
