import { plainBody, readSequenceCsv } from "@/lib/sequence-import";
import { done, is, part } from "./check";

const actual = "https://example.com/guide";
const decoy = "https://elsewhere.example/wrong";
const tracker = "https://ct.sendgrid.net/ls/click?x=1";
const csv = (body: string) => 'subject,body\n"Guide","' + body.replace(/"/g, '""') + '"';

part("An href inside another quoted attribute never supplies the destination");
for (const prefix of [
  `title=" href='${decoy}'"`,
  `data-note=' href="${decoy}"'`,
  `aria-label="quoted > href='${decoy}'"`,
  `title="\\n HREF = '${decoy}'"`.replace("\\n", "\n"),
]) {
  const input = `<p><a ${prefix} href="${actual}">Read the guide</a></p>`;
  is("real destination survives " + prefix, plainBody(input), { body: `Read the guide (${actual})`, variables: [], trackers: 0, images: 0 });
  const imported = readSequenceCsv(csv(input));
  is("CSV uses the same real destination " + prefix, imported.ok ? imported.steps[0].body : imported, `Read the guide (${actual})`);
}

part("Metadata must not create links or removal reports");
is("no href means words only", plainBody(`<a title=" href='${decoy}'">Read the guide</a>`).body, "Read the guide");
is("tracking address in title is not a tracking link", plainBody(`<a title=" href='${tracker}'" href="${actual}">Read</a>`), { body: `Read (${actual})`, variables: [], trackers: 0, images: 0 });
is("merge field in metadata is not a merge field in content", plainBody(`<a title=" href='https://example.com/{{ person.id }}'" href="${actual}">Read</a>`), { body: `Read (${actual})`, variables: [], trackers: 0, images: 0 });
is("actual tracker is removed even after a decoy address", plainBody(`<a title=" href='${actual}'" href="${tracker}">Read</a>`), { body: "Read", variables: [], trackers: 1, images: 0 });

part("Ordinary HTML links keep working");
for (const attributes of [
  `href="${actual}"`,
  `href='${actual}'`,
  `href=${actual}`,
  `download HREF = "${actual}"`,
  `title="a > b"\n\thref = '${actual}'`,
  `href="${actual}" title=" href='${decoy}'"`,
  `data-href="${decoy}" href="${actual}"`,
]) {
  is("supported real attribute " + attributes, plainBody(`<a ${attributes}>Read</a>`).body, `Read (${actual})`);
}
is("first actual duplicate href remains authoritative", plainBody(`<a href="${actual}" href="${decoy}">Read</a>`).body, `Read (${actual})`);
is("escaped ampersand in actual URL is decoded once", plainBody('<a title=" href=decoy" href="https://example.com/?a=1&amp;b=2">Read</a>').body, "Read (https://example.com/?a=1&b=2)");
is("non-web href retains only words", plainBody(`<a title=" href='${actual}'" href="javascript:alert(1)">Read</a>`).body, "Read");
is("unchanged attribute scan bound ignores a destination beyond it", plainBody(`<a title="${"x".repeat(4100)}" href="${actual}">Read</a>`).body, "Read");
done();
