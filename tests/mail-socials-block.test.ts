/**
 * The store's profiles in an email (546 [EB1], unit 1; added 2 November
 * 2026), on synthetic profiles only.
 */
import { SOCIALS_LINE, hasSocials, isSocialsLine, socialsHtml, socialsProblem, socialsText } from "@/lib/mail-socials-block";
import { parseSocials, type Social } from "@/lib/store-socials";
import { done, is, part } from "./check";

const kept: Social[] = parseSocials([{ network: "instagram", url: "https://www.instagram.com/ana" }, { network: "email", url: "mailto:ana@example.com" }, { network: "website", url: "https://ana.example" }]);

part("The line");
is("a paragraph of its own", [isSocialsLine(SOCIALS_LINE), isSocialsLine(`  ${SOCIALS_LINE} `), isSocialsLine(`See ${SOCIALS_LINE}`), hasSocials(`Hi\n\n${SOCIALS_LINE}`), hasSocials(`Hi\n${SOCIALS_LINE}`)], [true, true, false, true, false]);

part("Before it goes");
is("refused with no profiles kept, said in plain words", [socialsProblem(`Hi\n\n${SOCIALS_LINE}`, []), socialsProblem(`Hi\n\n${SOCIALS_LINE}`, kept), socialsProblem("Hi", [])], ["Your store has no profiles to show yet. Add them under your store's name in the studio, or take the profiles out of the email.", null, null]);

part("The row");
const html = socialsHtml(kept, (href) => `${href}?ref=mail`);
is("the profiles as the store keeps them, in its order", [...html.matchAll(/>([A-Za-z]+)<\/a>/g)].map((m) => m[1]), ["Instagram", "Email", "Website"]);
is("each name, never a logo", [html.includes(">Instagram</a>"), html.includes(">Email</a>"), html.includes(">Website</a>"), html.includes("<img")], [true, true, true, false]);
is("links carry the email's tag; an email address does not", [html.includes('href="https://www.instagram.com/ana?ref=mail"'), html.includes('href="mailto:ana@example.com"')], [true, true]);
is("only addresses the store page would link", socialsHtml([{ network: "website", url: "javascript:alert(1)" } as Social, { network: "x", url: "http://x.com/a" } as Social]), "");
is("none: nothing drawn", socialsHtml([]), "");
is("in plain text: each name and where it goes", socialsText(kept), "Instagram: https://www.instagram.com/ana\nEmail: ana@example.com\nWebsite: https://ana.example/");

done();
