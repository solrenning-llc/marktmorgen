/**
 * Links to a member's profiles elsewhere in the community's member directory
 * (601 [KB22], unit U12; added 6 November 2026; lib/member-links.ts).
 * Checked:
 *
 *   - only an https profile on a known social network's own host is kept,
 *     rebuilt by lib/store-socials.ts, without the query a share button adds;
 *     never an email address, a phone number, a website, a bare handle, an
 *     http address or a lookalike host; at most three, no repeats, and every
 *     box turned away is counted so the member is told;
 *   - a record read back is cleaned the same way, so nothing the form would
 *     refuse today reaches the page;
 *   - links show only for a member who is listed, named, not muted and not
 *     taken out;
 *   - the member record (and so the walk that reads it) stays inside its
 *     stated worst size with the links in it;
 *   - the directory draws each link with a name that says whose profile and
 *     where (WCAG 2.4.9) and contains the visible word (2.5.3), no new window,
 *     no referrer; the member's page asks for them in labeled boxes; the
 *     route keeps them only from that page and says when one was turned away;
 *   - the record that holds them is erased and copied with the person, and
 *     the privacy page and the help say what is kept and who sees it.
 */
import { readFileSync } from "node:fs";
import {
  MAX_MEMBER_LINKS,
  MAX_MEMBER_LINK_URL,
  MEMBER_LINK_NETWORKS,
  MEMBER_LINK_REL,
  memberLinkFrom,
  memberLinkLabels,
  memberLinksFromForm,
  parseMemberLinks,
  shownLinks,
} from "@/lib/member-links";
import { readMember } from "@/lib/community";
import { MEMBER_ROW_BYTES } from "@/lib/api-read-rules";
import { networkFor } from "@/lib/store-socials";
import { WALK_MEMBER_BYTES } from "@/lib/community-walk";
import { MAX_ANSWER, MAX_DISPLAY_NAME, MAX_QUESTION, MAX_QUESTIONS } from "@/lib/community-text";
import { COMMUNITY_WORDS } from "@/lib/buyer-words/community";
import { communityNotices } from "@/components/community-parts";
import { PERSON_DATA } from "@/lib/person-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const url = (typed: string) => memberLinkFrom(typed)?.url ?? null;

part("What a member may link to");
is("an Instagram profile is kept as its own address", memberLinkFrom("https://www.instagram.com/ana.silva"), { network: "instagram", url: "https://www.instagram.com/ana.silva" });
is("an address typed without https is read as https", url("instagram.com/ana"), "https://instagram.com/ana");
// Changed at review (rule 23): only what a share button adds is dropped, not the whole query, since
// some profiles are named by it (Facebook's profile.php?id=).
is("what a share button adds after ? or # is dropped", [url("https://www.instagram.com/ana?igsh=abc123&utm_source=qr#top"), url("https://open.spotify.com/user/ana?si=abc"), url("https://x.com/ana?s=20&t=abc")], ["https://www.instagram.com/ana", "https://open.spotify.com/user/ana", "https://x.com/ana"]);
is("a profile named by its query keeps it", url("https://www.facebook.com/profile.php?id=100012345&mibextid=abc"), "https://www.facebook.com/profile.php?id=100012345");
is("a handle with a dot after @ is a profile, not an email address", [url("https://www.tiktok.com/@ana.silva"), url("https://www.youtube.com/@ana.silva"), url("https://www.threads.net/@ana.silva")], ["https://www.tiktok.com/@ana.silva", "https://www.youtube.com/@ana.silva", "https://www.threads.net/@ana.silva"]);
is("the network itself is no one's profile", [url("https://instagram.com"), url("https://www.instagram.com/"), url("https://substack.com/"), url("https://www.substack.com/ana")], [null, null, null, null]);
is("a Substack is its own address under substack.com", url("https://ana.substack.com"), "https://ana.substack.com/");
is("YouTube, TikTok, LinkedIn and GitHub profiles are kept", ["https://www.youtube.com/@ana", "https://www.tiktok.com/@ana", "https://www.linkedin.com/in/ana", "https://github.com/ana"].map((t) => memberLinkFrom(t)?.network), ["youtube", "tiktok", "linkedin", "github"]);
is("a handle alone names no network, so it is not kept", [url("@ana"), url("ana")], [null, null]);
is("an email address is never a member's link", [url("ana@example.com"), url("mailto:ana@example.com")], [null, null]);
is("a phone number (WhatsApp) is never a member's link", [url("https://wa.me/15550100000"), url("+" + "1 (555) 010-0000")], [null, null]);
is("a website that is no social network is not kept", url("https://example.com/me"), null);
is("http is not kept", url("http://www.instagram.com/ana"), null);
is("a host that only looks like the network is not kept", [url("https://instagram.com.evil.example/ana"), url("https://evilinstagram.com/ana"), url("https://evil.example/instagram.com/ana")], [null, null, null]);
// Added at review (LEVE, independent review of 6 November 2026, comment 6698301155): a network's own
// link redirector is on the network's host but sends the reader to another site, under a label
// that says the network (WCAG 2.4.9), so it is no profile.
const away = encodeURIComponent("https://evil.example/");
is("a network's own redirector to another site is not kept", [
  url(`https://l.facebook.com/l.php?u=${away}`),
  url(`https://lm.facebook.com/l.php?u=${away}`),
  url(`https://www.youtube.com/redirect?q=${away}`),
  url(`https://www.linkedin.com/redir/redirect?url=${away}`),
  url(`https://www.instagram.com/linkshim/?u=${away}`),
], [null, null, null, null, null]);
is("a query that carries another address is not kept, however it is written", [
  url(`https://www.pinterest.com/offsite/?url=${away}`),
  url("https://t.me/iv?url=//evil.example/"),
  url(`https://www.facebook.com/ana?next=${encodeURIComponent(away)}`),
  url("https://x.com/ana?u=https://evil.example/"),
], [null, null, null, null]);
is("an address inside the path is not kept", [url("https://x.com/https://evil.example/"), url(`https://x.com/go/${away}`)], [null, null]);
is("a redirector path or host is not kept even without a destination", [
  url("https://www.facebook.com/l.php?u=evil.example"),
  url("https://l.instagram.com/ana"),
  url("https://www.youtube.com/redirect?q=evil.example"),
], [null, null, null]);
is("a stored redirector is left out when read back", parseMemberLinks([{ network: "facebook", url: `https://l.facebook.com/l.php?u=${away}` }, { network: "youtube", url: `https://www.youtube.com/redirect?q=${away}` }]), []);
is("a profile's own query and path still pass", [url("https://www.facebook.com/profile.php?id=100012345"), url("https://www.youtube.com/@ana/videos"), url("https://www.linkedin.com/in/ana")], ["https://www.facebook.com/profile.php?id=100012345", "https://www.youtube.com/@ana/videos", "https://www.linkedin.com/in/ana"]);
is("an address with a user and password is not kept", url("https://user:pw@www.instagram.com/ana"), null);
is("a script address is not kept", url("javascript:alert(1)//instagram.com/"), null);
is("an address longer than the limit is not kept", url(`https://www.instagram.com/${"a".repeat(MAX_MEMBER_LINK_URL)}`), null);
is("email, WhatsApp and website are not among the networks", ["email", "whatsapp", "website"].some((n) => (MEMBER_LINK_NETWORKS as readonly string[]).includes(n)), false);

part("The network is read from the host, before anything looks like an email address");
is("store socials: a dotted handle after @ in an address is the network's", [networkFor("https://www.tiktok.com/@ana.silva"), networkFor("tiktok.com/@ana.silva")], ["tiktok", "tiktok"]);
is("store socials: an address alone is still email", [networkFor("ana.silva@example.com"), networkFor("mailto:ana@example.com")], ["email", "email"]);

part("Each link's words tell it apart");
is("one link on a network is named by the network", memberLinkLabels([{ network: "instagram", url: "https://www.instagram.com/ana" }]), ["Instagram"]);
is("two on the same network each say which", memberLinkLabels([{ network: "instagram", url: "https://www.instagram.com/ana" }, { network: "github", url: "https://github.com/ana" }, { network: "instagram", url: "https://www.instagram.com/ana.art" }]), ["Instagram (instagram.com/ana)", "GitHub", "Instagram (instagram.com/ana.art)"]);

part("What the form keeps");
const sent = memberLinksFromForm(["https://www.instagram.com/ana", "", "instagram.com/ana?igsh=x", "https://example.com"]);
// Changed at review (rule 23): the same profile written two ways (with or without www, a capital, a
// trailing slash, a share query) is one link, not two that read the same.
is("kept in order, a repeat once however it is written, empty boxes ignored", sent.links.map((l) => l.url), ["https://www.instagram.com/ana"]);
is("the same profile with a capital and a slash is a repeat", memberLinksFromForm(["https://github.com/ana", "github.com/Ana/"]).links.length, 1);
is("a box turned away is counted", memberLinksFromForm(["https://www.instagram.com/ana", "https://example.com"]).refused, 1);
is("a repeat is not a refusal", memberLinksFromForm(["https://github.com/ana", "https://github.com/ana"]), { links: [{ network: "github", url: "https://github.com/ana" }], refused: 0 });
const many = memberLinksFromForm(["https://github.com/a", "https://github.com/b", "https://github.com/c", "https://github.com/d"]);
is("at most three are kept, and a fourth is counted as turned away", [many.links.length, many.refused], [MAX_MEMBER_LINKS, 1]);
is("anything that is not text is ignored", memberLinksFromForm([null, 5, {}] as unknown[]), { links: [], refused: 0 });

part("What a record gives back");
is("a stored entry the form would refuse today is left out", parseMemberLinks([
  { network: "website", url: "https://example.com" },
  { network: "email", url: "mailto:a@example.com" },
  { network: "instagram", url: "https://evil.example/x" },
  { network: "instagram", url: "javascript:alert(1)" },
  { network: "x", url: "https://x.com/ana?ref=1" },
  { network: "x", url: "https://x.com/ana" },
  "https://x.com/bob",
]), [{ network: "x", url: "https://x.com/ana" }]);
is("never more than three", parseMemberLinks(["a", "b", "c", "d"].map((h) => ({ network: "github", url: `https://github.com/${h}` }))).length, MAX_MEMBER_LINKS);
is("anything that is not a list gives none", [parseMemberLinks(null), parseMemberLinks("x"), parseMemberLinks({})], [[], [], []]);

part("Who is shown with links");
const links = [{ network: "github" as const, url: "https://github.com/ana" }];
const base = { dir: true, n: "Ana", muted: false, removed: false, s: links };
is("a listed, named member shows them", shownLinks(base), links);
is("not listed shows none", shownLinks({ ...base, dir: false }), []);
is("no name shows none", shownLinks({ ...base, n: "" }), []);
is("a muted member shows none, so the creator's mute stops a spammer's links at once", shownLinks({ ...base, muted: true }), []);
is("a member taken out shows none", shownLinks({ ...base, removed: true }), []);

async function main(): Promise<void> {
part("The member record keeps them, cleaned, and stays inside its size");
const cid = "cmlinks01";
await redis.pipeline([
  ["HSET", `nl:cm:${cid}:m`, "kold", JSON.stringify({ k: "kold", e: "old@example.com", n: "Old", dir: true })],
  ["HSET", `nl:cm:${cid}:m`, "knew", JSON.stringify({ k: "knew", e: "new@example.com", n: "New", dir: true, s: [{ network: "github", url: new URL("/new", "https://github.com").href }, { network: "website", url: new URL("https://example.com").href }] })],
]);
is("a record from before links has none", (await readMember(cid, "kold"))?.s, []);
is("a record's links are read back cleaned", (await readMember(cid, "knew"))?.s, [{ network: "github", url: "https://github.com/new" }]);
// Changed at review (rule 23): a three-byte character, the most a cleaned unit weighs, not an emoji
// (two bytes a unit) or a quote (two), so an undercount would show.
const wide = "\u20ac";
const worst = {
  k: "k".repeat(64),
  // An address is not cleaned of control characters, so each can be a six-byte escape.
  e: `${"\u0001".repeat(64)}@${"d".repeat(185)}.com`,
  n: wide.repeat(MAX_DISPLAY_NAME),
  h: wide.repeat(MAX_DISPLAY_NAME),
  dir: true,
  mail: true,
  at: 9_999_999_999,
  seen: 9_999_999_999,
  muted: false,
  removed: false,
  t: "f".repeat(40),
  q: Array.from({ length: MAX_QUESTIONS }, () => wide.repeat(MAX_ANSWER)),
  qq: Array.from({ length: MAX_QUESTIONS }, () => wide.repeat(MAX_QUESTION)),
  qa: 9_999_999_999,
  s: Array.from({ length: MAX_MEMBER_LINKS }, (_, i) => ({ network: "substack", url: `https://${String(i).padEnd(MAX_MEMBER_LINK_URL - 22, "a")}.substack.com/` })),
};
// Changed at review (rule 23): one figure for a member record at its largest, the one the API's
// reads already use (lib/api-read-rules.ts), rather than a second one beside it.
is("a record with every field at its worst fits the one stated size", Buffer.byteLength(JSON.stringify(worst)) <= MEMBER_ROW_BYTES, true);
is("the walk that reads members is charged at that size", WALK_MEMBER_BYTES, MEMBER_ROW_BYTES);
is("the stated size names the links", readFileSync("lib/api-read-rules.ts", "utf8").includes("MAX_MEMBER_LINKS (3) links"), true);
}

part("Words, in every language of a store");
for (const [code, w] of Object.entries(COMMUNITY_WORDS)) {
  const named = w.linkOn("Ana", "Instagram");
  is(`${code}: each link says whose profile and on which network, and holds the visible word`, named.includes("Ana") && named.includes("Instagram"), true);
  is(`${code}: the boxes have a legend, a note, and a label each`, [w.linksLegend, w.linksNote, w.linkLabel(1), w.linkLabel(3)].every((t) => typeof t === "string" && t.length > 3) && w.linkLabel(1) !== w.linkLabel(3), true);
  is(`${code}: a turned-away link is told, as a warning`, communityNotices(code).savedlinkoff?.tone, "warn");
  // Changed at fix (rule 23): rather than finding the address in the words, the example they give is
  // read out and must be an Instagram profile the rule itself keeps.
  const example = typeof w.linkRefused === "string" ? /https:\/\/\S+?(?=\.?(?:\s|$))/.exec(w.linkRefused)?.[0] : undefined;
  is(`${code}: a box the rule would refuse says so beside it, before sending, with an example the rule keeps`, example !== undefined && memberLinkFrom(example)?.network === "instagram", true);
}
is("the note says links show only while listed", COMMUNITY_WORDS.en.linksNote.includes("only while you are listed"), true);

part("The pages and the route");
const members = readFileSync("app/[handle]/community/members/page.tsx", "utf8");
is("the directory draws only shownLinks(m)", members.includes("shownLinks(m)"), true);
is("each link has no referrer and is the member's own words", members.includes("rel={MEMBER_LINK_REL}") && MEMBER_LINK_REL === "ugc nofollow noreferrer", true);
// Changed at review (rule 23): named from memberLinkLabels, which tells two links on one network apart.
is("each link is named by whose profile and where", members.includes("aria-label={w.linkOn(m.n, labels[i])}") && members.includes("memberLinkLabels(links)"), true);
is("no link opens a new window", /target=/.test(members), false);
is("the links are a list with its own name", members.includes("<ul") && members.includes("aria-label={w.linksOf(m.n)}"), true);
// Changed at review (rule 23): the boxes moved into components/member-link-boxes.tsx, which checks each
// one with the server's own rule as it is typed, so a refused address stays in its box to fix (WCAG 3.3.7).
const you = readFileSync("app/[handle]/community/you/page.tsx", "utf8") + readFileSync("components/member-link-boxes.tsx", "utf8");
is("the member's page asks for them in a group with a legend", you.includes("<legend") && you.includes("legend: w.linksLegend"), true);
// Changed before the first green (rule 23): type="text" with inputMode="url", not type="url", whose
// browser check refuses "instagram.com/ana" (which the rule keeps) with a bubble screen readers announce unevenly.
// Changed at fix (rule 23): "labeled", American spelling (tests/platform-us-english.test.ts); the check is the same.
is("one labeled box per link, an address keyboard, no browser check of its own", you.includes('name="link"') && you.includes('type="text"') && you.includes('inputMode="url"') && you.includes("htmlFor={`you-link-${i}`}") && you.includes("MAX_MEMBER_LINKS"), true);
is("the page says it sends links, so an older page never wipes them", you.includes('name="links" value="1"'), true);
is("no box cuts a pasted address short without saying so", /name="link"[\s\S]{0,400}maxLength/.test(you), false);
is("each box is checked with the rule the server keeps by", you.includes("memberLinkFrom(") && you.includes('"use client"'), true);
is("a refused box says why beside it and is marked invalid", you.includes("aria-invalid={") && you.includes("aria-describedby={") && you.includes("words.refused"), true);
is("sending with a refused box stops and goes to it, keeping what was typed", you.includes("event.preventDefault()") && you.includes(".focus()"), true);
const route = readFileSync("app/api/store/community/route.ts", "utf8");
is("the route keeps them through the same rule, only from that page", route.includes('form.get("links") === "1" ? memberLinksFromForm(form.getAll("link")) : null'), true);
is("and says when one was turned away", route.includes('sentLinks && sentLinks.refused ? "savedlinkoff" : "saved"'), true);

part("Erased, copied and said");
is("the member record they live in is erased with the person", PERSON_DATA.some((row) => row.file === "lib/community.ts" && row.how === "erased" && /links to their profiles/.test(row.what)), true);
is("a person's copy of their data carries them", readFileSync("lib/person-copy.ts", "utf8").includes("links: member.s.map((l) => l.url)"), true);
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
is("the privacy page says what is kept and who sees it", privacy.includes("links to their profiles on social networks") && privacy.includes("only of those who asked to be listed"), true);
is("the help says it", readFileSync("lib/help-content.ts", "utf8").includes("up to three links to their profiles on social networks"), true);

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
