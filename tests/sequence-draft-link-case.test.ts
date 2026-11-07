import { keepOwnLinks, readDraftedSteps } from "@/lib/sequence-draft";
import { done, is, part } from "./check";

const own = "https://example.com/Guide";
const links = [own];
part("An external draft URL is rejected for every protocol spelling");
for (const scheme of ["https", "HTTPS", "Https", "hTtPs", "http", "HTTP", "Http", "hTtP"]) {
  const foreign = `${scheme}://elsewhere.example/invented`;
  is(`${scheme}: the whole foreign-link line is removed`, keepOwnLinks(`Keep this.\nRead ${foreign} now.`, links), "Keep this.");
  is(`${scheme}: an email containing only that address is not kept`, readDraftedSteps([{ subject: "Guide", body: foreign, waitDays: 0 }], 3, links), []);
  const steps = readDraftedSteps([{ subject: "Guide", body: `Keep this.\n${foreign}`, waitDays: 0 }], 3, links);
  is(`${scheme}: the real step reader keeps only safe text`, steps.map((s) => s.body), ["Keep this."]);
}

part("Permitted destinations keep their words and path case");
for (const scheme of ["https", "HTTPS", "Https", "hTtPs"]) {
  const address = own.replace("https", scheme);
  is(`${scheme}: permitted URL is retained without rewriting`, keepOwnLinks(`Read ${address}.`, links), `Read ${address}.`);
  is(`${scheme}: allowed URL in a real step survives`, readDraftedSteps([{ subject: "Guide", body: address, waitDays: 0 }], 3, links).map((s) => s.body), [address]);
}
is("case of a path is never broadened", keepOwnLinks("Keep this.\nHTTPS://example.com/guide", links), "Keep this.");
is("lookalike destination remains refused", keepOwnLinks("Keep this.\nHTTPS://example.com.evil.example/Guide", links), "Keep this.");
is("a mixed line with one foreign address is entirely removed", keepOwnLinks(`${own} and HTTPS://elsewhere.example/wrong\nKeep this.`, links), "Keep this.");
is("protocol case in the allowlist is normalized too", keepOwnLinks(own, [own.replace("https", "HTTPS")]), own);
is("punctuation and trailing slash compatibility is retained", keepOwnLinks(`Read ${own}/.`, links), `Read ${own}/.`);
is("neutral paragraphs are unchanged", keepOwnLinks("Hello.\n\nA tip for today.", links), "Hello.\n\nA tip for today.");
done();
