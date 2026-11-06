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
 *     no referrer; the member's page asks for them in labelled boxes; the
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
  memberLinksFromForm,
  parseMemberLinks,
  shownLinks,
} from "@/lib/member-links";
import { MEMBER_RECORD_MAX_BYTES, readMember } from "@/lib/community";
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
is("what a share button adds after ? or # is dropped", url("https://www.instagram.com/ana?igsh=abc123#top"), "https://www.instagram.com/ana");
is("YouTube, TikTok, LinkedIn and GitHub profiles are kept", ["https://www.youtube.com/@ana", "https://www.tiktok.com/@ana", "https://www.linkedin.com/in/ana", "https://github.com/ana"].map((t) => memberLinkFrom(t)?.network), ["youtube", "tiktok", "linkedin", "github"]);
is("a handle alone names no network, so it is not kept", [url("@ana"), url("ana")], [null, null]);
is("an email address is never a member's link", [url("ana@example.com"), url("mailto:ana@example.com")], [null, null]);
is("a phone number (WhatsApp) is never a member's link", [url("https://wa.me/5585999999999"), url("+55 85 99999-9999")], [null, null]);
is("a website that is no social network is not kept", url("https://example.com/me"), null);
is("http is not kept", url("http://www.instagram.com/ana"), null);
is("a host that only looks like the network is not kept", [url("https://instagram.com.evil.example/ana"), url("https://evilinstagram.com/ana"), url("https://evil.example/instagram.com/ana")], [null, null, null]);
is("an address with a user and password is not kept", url("https://user:pw@www.instagram.com/ana"), null);
is("a script address is not kept", url("javascript:alert(1)//instagram.com/"), null);
is("an address longer than the limit is not kept", url(`https://www.instagram.com/${"a".repeat(MAX_MEMBER_LINK_URL)}`), null);
is("email, WhatsApp and website are not among the networks", ["email", "whatsapp", "website"].some((n) => (MEMBER_LINK_NETWORKS as readonly string[]).includes(n)), false);

part("What the form keeps");
const sent = memberLinksFromForm(["https://www.instagram.com/ana", "", "instagram.com/ana?igsh=x", "https://example.com"]);
is("kept in order, a repeat once, empty boxes ignored", sent.links.map((l) => l.url), ["https://www.instagram.com/ana", "https://instagram.com/ana"]);
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
  ["HSET", `nl:cm:${cid}:m`, "knew", JSON.stringify({ k: "knew", e: "new@example.com", n: "New", dir: true, s: [{ network: "github", url: "https://github.com/new" }, { network: "website", url: "https://example.com" }] })],
]);
is("a record from before links has none", (await readMember(cid, "kold"))?.s, []);
is("a record's links are read back cleaned", (await readMember(cid, "knew"))?.s, [{ network: "github", url: "https://github.com/new" }]);
const wide = "\u{1F600}";
const worst = {
  k: "k".repeat(64),
  e: `${"e".repeat(64)}@${"d".repeat(185)}.com`,
  n: wide.repeat(MAX_DISPLAY_NAME / 2),
  h: "h".repeat(44),
  dir: true,
  mail: true,
  at: 9_999_999_999,
  seen: 9_999_999_999,
  muted: false,
  removed: false,
  t: "f".repeat(40),
  q: Array.from({ length: MAX_QUESTIONS }, () => '"'.repeat(MAX_ANSWER)),
  qq: Array.from({ length: MAX_QUESTIONS }, () => '"'.repeat(MAX_QUESTION)),
  qa: 9_999_999_999,
  s: Array.from({ length: MAX_MEMBER_LINKS }, (_, i) => ({ network: "substack", url: `https://${String(i).padEnd(MAX_MEMBER_LINK_URL - 22, "a")}.substack.com/` })),
};
is("a record with every field at its worst fits the stated size", Buffer.byteLength(JSON.stringify(worst)) <= MEMBER_RECORD_MAX_BYTES, true);
is("the walk that reads members is charged at that size", WALK_MEMBER_BYTES, MEMBER_RECORD_MAX_BYTES);
}

part("Words, in every language of a store");
for (const [code, w] of Object.entries(COMMUNITY_WORDS)) {
  const named = w.linkOn("Ana", "Instagram");
  is(`${code}: each link says whose profile and on which network, and holds the visible word`, named.includes("Ana") && named.includes("Instagram"), true);
  is(`${code}: the boxes have a legend, a note, and a label each`, [w.linksLegend, w.linksNote, w.linkLabel(1), w.linkLabel(3)].every((t) => typeof t === "string" && t.length > 3) && w.linkLabel(1) !== w.linkLabel(3), true);
  is(`${code}: a turned-away link is told, as a warning`, communityNotices(code).savedlinkoff?.tone, "warn");
}
is("the note says links show only while listed", COMMUNITY_WORDS.en.linksNote.includes("only while you are listed"), true);

part("The pages and the route");
const members = readFileSync("app/[handle]/community/members/page.tsx", "utf8");
is("the directory draws only shownLinks(m)", members.includes("shownLinks(m)"), true);
is("each link has no referrer and is the member's own words", members.includes("rel={MEMBER_LINK_REL}") && MEMBER_LINK_REL === "ugc nofollow noreferrer", true);
is("each link is named by whose profile and where", members.includes("aria-label={w.linkOn(m.n, memberLinkLabel(link))}"), true);
is("no link opens a new window", /target=/.test(members), false);
is("the links are a list with its own name", members.includes("<ul") && members.includes("aria-label={w.linksOf(m.n)}"), true);
const you = readFileSync("app/[handle]/community/you/page.tsx", "utf8");
is("the member's page asks for them in a group with a legend", you.includes("<legend") && you.includes("{w.linksLegend}"), true);
is("one labelled box per link, as addresses", you.includes('name="link"') && you.includes('type="url"') && you.includes("htmlFor={`you-link-${i}`}") && you.includes("MAX_MEMBER_LINKS"), true);
is("the page says it sends links, so an older page never wipes them", you.includes('name="links" value="1"'), true);
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
