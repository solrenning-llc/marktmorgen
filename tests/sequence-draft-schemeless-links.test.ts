import { keepOwnLinks, readDraftedSteps } from "@/lib/sequence-draft";
import { done, is, part } from "./check";

const allowed = ["https://own.example", "https://own.example/p", "https://www.own.example/p", "http://legacy.own.example/Guide?Keep=Y"];
part("A mail client must not turn an invented schemeless address into a foreign link");
for (const address of [
  "www.evil.test", "WWW.EVIL.TEST/path?A=Keep", "evil.test/path", "sub.evil.test/path",
  "evil.test:8443/path", "www.own.example.evil.test/path", "www.own.example@evil.test/path",
  "evil.test/a?next=https://own.example/p", "//evil.test/path", "//own.example@evil.test/path",
  "//reader:secret@evil.test/path", "evil.test/path#fragment",
]) {
  is(`${address}: remove its entire line`, keepOwnLinks(`Welcome.\nRead ${address} now.\nSee you soon.`, allowed), "Welcome.\nSee you soon.");
  is(`${address}: a foreign-only step is omitted`, readDraftedSteps([{ subject: "A draft", body: address, waitDays: 0 }], 3, allowed), []);
}
part("Own destinations keep their exact original spelling and path/query case");
for (const address of ["own.example/p", "//own.example/p", "www.own.example/p", "legacy.own.example/Guide?Keep=Y", "HTTPS://own.example/p", "https://www.own.example/p"]) {
  is(`${address}: allowed destination stays unchanged`, keepOwnLinks(`Read ${address}.`, allowed), `Read ${address}.`);
}
is("foreign path case is never changed to match an allowed path", keepOwnLinks("legacy.own.example/guide?Keep=Y", allowed), "");
is("foreign query case is never changed to match an allowed query", keepOwnLinks("legacy.own.example/Guide?keep=Y", allowed), "");
is("a line mixing own and foreign schemeless addresses is removed", keepOwnLinks("own.example/p and evil.test/path", allowed), "");
part("Ordinary words, email addresses and local file/path references are preserved");
for (const text of ["Version 2.0 is ready.", "Contact member@example.com.", "member@evil.test/path", "Read guide.pdf.", "e.g. take a look.", "Use /guide/next.", "Keep your notes."]) {
  is(text, keepOwnLinks(text, allowed), text);
}
is("the creator's original draft text and delay rules remain", readDraftedSteps([
  { subject: "A draft", body: "Welcome.\nown.example/p", waitDays: 0 },
  { subject: "Next", body: "Read www.own.example/p.", waitDays: 3 },
], 3, allowed), [
  { delayHours: 0, subject: "A draft", body: "Welcome.\nown.example/p" },
  { delayHours: 72, subject: "Next", body: "Read www.own.example/p." },
]);
done();
