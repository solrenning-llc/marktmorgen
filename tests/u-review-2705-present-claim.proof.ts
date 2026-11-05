import { readFileSync } from "node:fs";
import { sendSignedCopies } from "@/lib/agreements";
import { agreementWords } from "@/lib/buyer-words/agreements";
import type { Agreement, AgreementVersion, Signature } from "@/lib/agreement-rules";
import type { Store } from "@/lib/store";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { state } from "./u-agreement-copy-world";
import { done, is } from "./check";

const name = "Sample Signer";
const date = "Sample date";
const unqualifiedSentClaim: Record<string, RegExp> = {
  en: /a copy is sent by email/i,
  es: /se envía una copia por email/i,
  fr: /une copie est envoyée par e-mail/i,
  de: /(?:eine kopie wird|wird eine kopie) per e-mail .* geschickt/i,
  it: /una copia viene inviata via email/i,
  nl: /(?:er wordt een kopie|wordt een kopie) per e-mail .*gestuurd/i,
  pt: /é enviada uma cópia por email/i,
};

globalThis.fetch = async () => {
  throw new Error("No external fetch is allowed in this proof");
};

async function main() {
  for (const language of LANGUAGE_CODES) {
    const store = { handle: "sample", name: "Sample", email: "creator@example.test", language, currency: "usd" } as unknown as Store;
    const agreement = { id: "a".repeat(32), kind: "agreement", name, email: "signer@example.test", copies: 0, sent: [], failed: "", versions: [] } as unknown as Agreement;
    const version = { n: 1, currency: "usd", title: "Sample record", text: "Synthetic text only" } as AgreementVersion;
    const signature = { name, at: 1_800_000_000_000, sha256: "b".repeat(64), consent: "Synthetic consent", ipHash: "" } as Signature;
    state.agreement = agreement;
    const result = await sendSignedCopies(store, agreement, version, signature);
    is(`${language}: the real sender confirms neither copy was sent`, result, { signer: false, creator: false });
    const words = agreementWords(language);
    const signedMessage = words.signedBody(name, date);
    const beforeMessage = words.before("Sample Store");
    is(`${language}: the signer and date remain visible`, [signedMessage.includes(name), signedMessage.includes(date)], [true, true]);
    is(
      `${language}: refusal cannot justify unqualified present-tense sent claims`,
      [unqualifiedSentClaim[language].test(signedMessage), unqualifiedSentClaim[language].test(beforeMessage)],
      [false, false],
    );
  }
  is("both synthetic sender attempts occurred once per language", state.attempts, 14);
  is("the real sender records failure and no sent copies", [state.agreement?.copies, Boolean(state.agreement?.failed)], [0, true]);
  const route = readFileSync("app/api/store/agreement-sign/route.ts", "utf8");
  const page = readFileSync("app/[handle]/sign/[agreement]/page.tsx", "utf8");
  is("the route returns signed after the copy attempt", route.indexOf('return back("signed")') > route.indexOf("await sendSignedCopies"), true);
  is("the reopened page has no sender result for signedBody", page.includes("w.signedBody(signature.name, said.date(signature.at))"), true);
  done();
}

void main();
