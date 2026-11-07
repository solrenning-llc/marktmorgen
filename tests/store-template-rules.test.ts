/**
 * A store shared as a template for another creator to copy (379 [TB5],
 * unit 1; added 7 November 2026): the words of what is shared never carry a
 * private link, a key, an email address or a phone number. The rules, on
 * synthetic words only. No store is read or written here.
 */
import { MAX_STORED_PAGE_BYTES } from "@/lib/sales-page";
import { productSegment } from "@/lib/product-slug";
import { TEMPLATE_FIELD_MAX_CHARS, TEMPLATE_MARKS, scrubTemplateText, scrubTemplateUrl, templateScrubSummary } from "@/lib/store-template-rules";
import { done, is, part } from "./check";

const clean = (text: string) => {
  const out = scrubTemplateText(text);
  return out.ok ? out.text : `refused: ${out.why}`;
};
const counts = (text: string) => {
  const out = scrubTemplateText(text);
  return out.ok ? out.removed : `refused: ${out.why}`;
};
/** Fictional numbers; the plus is kept apart so scripts/check_public_data.py never reads them as someone's number. */
const PLUS = "+";
const L = TEMPLATE_MARKS.link;
const K = TEMPLATE_MARKS.key;
const E = TEMPLATE_MARKS.email;
const P = TEMPLATE_MARKS.phone;

part("Words with nothing private stay exactly as written");
is("plain words", clean("Learn to bake sourdough in 30 days. Price: $49."), "Learn to bake sourdough in 30 days. Price: $49.");
is("a public link to a site, a video and a store page", clean("See https://www.youtube.com/watch?v=dQw4w9WgXcQ and https://example.com/about, or marktmorgen.com/ana/p/bread."), "See https://www.youtube.com/watch?v=dQw4w9WgXcQ and https://example.com/about, or marktmorgen.com/ana/p/bread.");
is("dates, times, prices and a short number", clean("Starts 2026-11-07 at 10:00. Was $1,299, now $999. Lesson 12 of 40."), "Starts 2026-11-07 at 10:00. Was $1,299, now $999. Lesson 12 of 40.");
is("a social handle is not an address", clean("Follow @ana_bakes on Instagram."), "Follow @ana_bakes on Instagram.");
is("a long number inside a public link is part of the link", clean("Order page: https://example.com/item/123456789012 today"), "Order page: https://example.com/item/123456789012 today");
is("scrubbed words scrubbed again do not change", (() => {
  const once = clean("Mail ana@example.com, see https://example.com/f?token=1 or https://example.com/a, call 555 123 4567, key sk_live_abcDEF123456.");
  return [once, clean(once), counts(once)];
})(), [`Mail ${E}, see ${L} or https://example.com/a, call ${P}, key ${K}.`, `Mail ${E}, see ${L} or https://example.com/a, call ${P}, key ${K}.`, { link: 0, key: 0, email: 0, phone: 0 }]);
is("nothing counted", counts("Plain words."), { link: 0, key: 0, email: 0, phone: 0 });

part("Private links are taken out");
is("a download or podcast feed of the store", clean("Get it: https://marktmorgen.com/api/store/download?t=abc and https://marktmorgen.com/api/store/podcast/feed/0123456789abcdef"), `Get it: ${L} and ${L}`);
is("on the creator's own domain too, and without https://", clean("ana.example/api/store/free/download?x=1"), L);
is("a buyer's certificate, an invitation, a takedown, a stop link and the studio", [clean("https://ana.example/ana/certificate/c123"), clean("https://marktmorgen.com/invite/abc"), clean("https://marktmorgen.com/takedown/abc"), clean("https://marktmorgen.com/outreach/stop/abc"), clean("https://marktmorgen.com/studio?store=s1"), clean("https://marktmorgen.com/unsubscribe?e=1")], [L, L, L, L, L, L]);
is("a link that carries an access value", [clean("https://example.com/file?token=abc"), clean("https://example.com/v?SIG=1"), clean("https://bucket.example/x?X-Amz-Signature=abc&X-Amz-Credential=y"), clean("https://example.com/cb#access_token=abc"), clean("https://zoom.us/j/123?pwd=abc")], [L, L, L, L, L]);
is("a name and password in the link", clean("https://ana:secret@example.com/members"), L);
is("a link with a long random part (a shared file)", clean("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view"), L);
is("files and meetings that live in someone's own account", [clean("https://www.dropbox.com/s/abc123/notes.pdf?dl=0"), clean("https://meet.google.com/abc-defg-hij"), clean("https://we.tl/t-abc"), clean("https://store-1.public.blob.vercel-storage.com/a.png"), clean("https://pub-1.r2.dev/a.png"), clean("https://vz-1.b-cdn.net/v.mp4")], [L, L, L, L, L, L]);
is("a link of another kind than a web page", [clean("ftp://example.com/a"), clean("javascript://alert(1)")], [L, `${L}(1)`]);
is("inside Markdown and HTML, the words around it kept", clean(`Read [the guide](https://example.com/g?token=1) or <a href="https://marktmorgen.com/api/store/claim?c=1">claim</a>.`), `Read [the guide](${L}) or <a href="${L}">claim</a>.`);
is("the stop at the end of a sentence stays", clean("Open https://example.com/f?key=1."), `Open ${L}.`);
is("counted", counts("https://example.com/f?key=1 https://marktmorgen.com/invite/a"), { link: 2, key: 0, email: 0, phone: 0 });

part("Keys and account ids are taken out");
is("payment keys, a webhook secret and an account id", clean("sk_live_abcDEF123456 rk_test_abcDEF123456 whsec_abcDEF123456 acct_1AbCdEfGhIjK pk_live_abcDEF123456"), `${K} ${K} ${K} ${K} ${K}`);
is("other services' keys", [clean("ghp_abcdefghijklmnopqrstuvwxyz0123"), clean("xoxb-1234567890-abcdefghij"), clean("AKIAABCDEFGHIJKLMNOP"), clean("AIzaSyA-abcdefghijklmnopqrstuvwxyz01234"), clean("re_abcdefghijklmnop1234")], [K, K, K, K, K]);
is("a signed token", clean("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), `Bearer ${K}`);
is("a long random string on its own (a license key)", clean("Your key: A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6"), `Your key: ${K}`);
is("a key inside a link: the whole link goes", clean("https://example.com/hook?x=sk_live_abcDEF123456"), K);
is("a long word without a digit stays", clean("Supercalifragilisticexpialidociousness"), "Supercalifragilisticexpialidociousness");

part("Email addresses and phone numbers are taken out");
is("an address, alone, in a mailto link and at the end of a sentence", clean("Write to ana@example.com, or <a href=\"mailto:help@ana.example?subject=Hi\">us</a>. Or bob.smith+news@mail.co.uk."), `Write to ${E}, or <a href="${E}">us</a>. Or ${E}.`);
is("phone numbers as people write them", [clean(`Call ${PLUS}1 (555) 123-4567 today`), clean(`WhatsApp: ${PLUS}55 85 99999-1234`), clean("555.123.4567"), clean(`<a href="tel:${PLUS}15551234567">call</a>`)], [`Call ${P} today`, `WhatsApp: ${P}`, P, `<a href="${P}">call</a>`]);
is("counted", counts(`ana@example.com and ${PLUS}1 555 123 4567 and bob@example.org`), { link: 0, key: 0, email: 2, phone: 1 });

part("Refused whole when it cannot be checked");
is("not words", [scrubTemplateText(42 as unknown as string), scrubTemplateText(null as unknown as string), scrubTemplateText({} as unknown as string)], [{ ok: false, why: "not_text" }, { ok: false, why: "not_text" }, { ok: false, why: "not_text" }]);
is("longer than any field a store keeps", [scrubTemplateText("a".repeat(TEMPLATE_FIELD_MAX_CHARS + 1)).ok, scrubTemplateText("a".repeat(TEMPLATE_FIELD_MAX_CHARS)).ok], [false, true]);
is("the cap holds the largest field a store keeps (a sales page)", TEMPLATE_FIELD_MAX_CHARS >= MAX_STORED_PAGE_BYTES, true);
is("an address written with look-alike characters", scrubTemplateText("ana＠example．com"), { ok: false, why: "unchecked" });
is("a link written with look-alike characters", scrubTemplateText("ｈｔｔｐｓ://example.com/f?token=1"), { ok: false, why: "unchecked" });
is("a long field of one word is read quickly", (() => {
  const started = Date.now();
  scrubTemplateText("a-".repeat(150_000));
  scrubTemplateText("1.".repeat(150_000));
  scrubTemplateText("a.".repeat(150_000));
  return Date.now() - started < 2_000;
})(), true);

part("Link fields (a button's or a picture's address)");
is("a public link kept", scrubTemplateUrl("https://example.com/about"), { ok: true, url: "https://example.com/about" });
is("a private link emptied", [scrubTemplateUrl("https://marktmorgen.com/api/store/download?t=1"), scrubTemplateUrl("https://example.com/x?token=1"), scrubTemplateUrl("mailto:ana@example.com"), scrubTemplateUrl(`tel:${PLUS}15551234567`)], [{ ok: true, url: null }, { ok: true, url: null }, { ok: true, url: null }, { ok: true, url: null }]);
is("anything but a web address emptied", [scrubTemplateUrl("javascript:alert(1)"), scrubTemplateUrl("data:text/html,hi"), scrubTemplateUrl("not a link"), scrubTemplateUrl("")], [{ ok: true, url: null }, { ok: true, url: null }, { ok: true, url: null }, { ok: true, url: null }]);
is("not words: refused", scrubTemplateUrl(7 as unknown as string), { ok: false, why: "not_text" });

part("What the preview says");
is("nothing found", templateScrubSummary({ link: 0, key: 0, email: 0, phone: 0 }), "We found no private links, keys, email addresses or phone numbers in your words.");
is("one of a kind, then several", templateScrubSummary({ link: 1, key: 0, email: 2, phone: 0 }), "Left out of the copy: 1 private link and 2 email addresses. The other creator sees a note where each one was, such as [private link removed].");
is("every kind", templateScrubSummary({ link: 2, key: 1, email: 1, phone: 3 }), "Left out of the copy: 2 private links, 1 key, 1 email address and 3 phone numbers. The other creator sees a note where each one was, such as [private link removed].");
is("only an address: the example is its own note", templateScrubSummary({ link: 0, key: 0, email: 1, phone: 0 }), "Left out of the copy: 1 email address. The other creator sees a note where each one was, such as [email address removed].");
is("counts that are not whole numbers: nothing is shared", [templateScrubSummary({ link: -1, key: 0, email: 0, phone: 0 }), templateScrubSummary({ link: 0.5, key: 0, email: 0, phone: 0 }), templateScrubSummary(null as unknown as { link: 0; key: 0; email: 0; phone: 0 })], Array(3).fill("We could not check your words for private details, so nothing is shared yet."));
is("many public links in one field, each kept in its place", clean(Array.from({ length: 12 }, (_, i) => `https://example.com/p${i} 5551234567${i}`).join(" ")), Array.from({ length: 12 }, (_, i) => `https://example.com/p${i} ${P}`).join(" "));
is("a field that already holds the marks used inside is refused", scrubTemplateText("a\uE000b"), { ok: false, why: "unchecked" });
is("the notes say what was there", TEMPLATE_MARKS, { link: "[private link removed]", key: "[key removed]", email: "[email address removed]", phone: "[phone number removed]" });

part("Common public links stay whole: a word slug is never random (review of 7 November 2026)");
is("the store's own product link, its words and its id", ["ab12cd", "a1b2c3d4e5"].map((id) => {
  const link = `https://marktmorgen.com/@ana/p/${productSegment({ id, title: "Sourdough masterclass for busy parents" })}`;
  return clean(link) === link;
}), [true, true]);
const publicLinks = [
  "https://example.com/blog/10-tips-for-better-bread",
  "https://marktmorgen.com/ana/p/sourdough-masterclass-2026-edition",
  "https://medium.com/@ana/how-i-built-a-store-8f3e2a1b9c0d",
  "https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
  "https://example.com/?utm_campaign=black-friday-2026-early-bird-offer",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
];
is("a blog post, a long slug, a Medium post, a playlist, a campaign tag and a video time", publicLinks.map(clean), publicLinks);
is("the same in a button's link field", scrubTemplateUrl("https://example.com/blog/10-tips-for-better-bread"), { ok: true, url: "https://example.com/blog/10-tips-for-better-bread" });

part("Words that only look like a key, an address or a phone number stay as written");
const plainWords = [
  "Our top-10-tips-for-sourdough-baking-at-home guide",
  "ISBN 978-3-16-148410-0",
  "Prices: 49 99 199 499",
  "Server 192.168.100.200",
  "Dates: 2026-11-07 2026-11-14",
  '<img src="/img/logo@2x.png" alt="">',
  "Run npm install react@18.3.1 first",
  "Talk to your acct_manager today",
  "#re_branding_masterclass_course",
  "Reach 1 000 000 000 people",
  "Years 2019 – 2023 – 2026",
];
is("a hyphenated phrase, an ISBN, a price list, an IP address, dates, a picture name, a package version, words with an underscore and a big number", plainWords.map(clean), plainWords);

part("More private details are taken out (review of 7 November 2026)");
/** Fictional secrets; a few are split so no scanner reads them as real ones. */
const leaks: Record<string, string> = {
  awsSecret: "AWS secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  envOpenAI: "OPENAI_API_KEY=sk-proj-abc123def456ghi789",
  envGeneric: "API_TOKEN=Zm9vYmFyMTIzNDU2Nzg5MA",
  base64Secret: "secret Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo+/==",
  anthropic: "sk-ant-api03-abcDEF123456ghiJKL789",
  githubPat: "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
  gitlab: "glpat" + "-abcdefghij1234567890",
  slackApp: "xoxe-1-abcdefghij123",
  telegramBot: "https://api.telegram.org/bot123456789:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage",
  zapierHook: "https://hooks.zapier.com/hooks/catch/1234567/abcdefg/",
  vimeoPrivate: "https://vimeo.com/123456789/abcdef1234",
  vimeoPlayerHash: "https://player.vimeo.com/video/123456789?h=abcdef1234",
  googlePhotos: "https://photos.app.goo.gl/AbCdEf123GhIj",
  googlePhotosShare: "https://photos.google.com/share/AF1QipMabc123",
  hashRoute: "https://app.example.com/#/reset?token=abc123",
  hostNoSlash: "example.com?token=abc123",
  authToken: "https://example.com/x?auth_token=abc123",
  privateToken: "https://gitlab.example.com/v4/x?private_token=abc123",
  oauthToken: "https://example.com/cb?oauth_token=abc123",
  shortT: "https://example.com/dl?t=abc123",
  jsessionid: "https://example.com/f;jsessionid=ABC123DEF",
  mmSignin: "https://marktmorgen.com/signin/confirm?c=abc123",
  mmManage: "https://marktmorgen.com/ana/manage?s=abc123",
  mmPay: "https://marktmorgen.com/ana/pay/req_abc123",
  mmSign: "https://marktmorgen.com/ana/sign/agr123",
  mmLibrary: "https://marktmorgen.com/library?s=abc123",
  mmMessages: "https://marktmorgen.com/ana/community/messages/u1-u2",
  mailtoPct: '<a href="mailto:ana%40example.com">mail</a>',
  htmlEntityEmail: "ana&#64;example.com",
  htmlEntityLink: '<a href="https&#58;//example.com/f?token=abc">x</a>',
  phoneSpacedDash: "Call 555 - 123 - 4567",
  phoneSlash: "Call 555/123/4567",
  phoneEnDash: "Call 555 – 123 – 4567",
  cyrillicScheme: "httpѕ://example.com/f?token=abc123",
};
is("none comes through as written", Object.entries(leaks).filter(([, text]) => clean(text) === text).map(([name]) => name), []);
is("an env line keeps its name, a key its words around", [clean("OPENAI_API_KEY=sk-proj-abc123def456ghi789"), clean("API_TOKEN=Zm9vYmFyMTIzNDU2Nzg5MA"), clean("AWS secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")], [`OPENAI_API_KEY=${K}`, `API_TOKEN=${K}`, `AWS secret: ${K}`]);
is("an encoded address: only it goes, the words around stay", [clean('<a href="mailto:ana%40example.com">mail</a>'), clean("Write ana&#64;example.com today"), clean('<a href="https&#58;//example.com/f?token=abc">x</a>')], [`<a href="${E}">mail</a>`, `Write ${E} today`, `<a href="${L}">x</a>`]);
is("phone numbers with spaced dashes and slashes", [clean("Call 555 - 123 - 4567"), clean("Call 555/123/4567"), clean("Call 555 – 123 – 4567")], [`Call ${P}`, `Call ${P}`, `Call ${P}`]);
is("a private video or hook in a button's link field is emptied", [scrubTemplateUrl("https://vimeo.com/123456789/abcdef1234"), scrubTemplateUrl("https://hooks.zapier.com/hooks/catch/1/a/")], [{ ok: true, url: null }, { ok: true, url: null }]);

done();
