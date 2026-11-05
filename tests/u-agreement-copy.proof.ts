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
const mailedClaim = {
  en: /A copy was emailed/,
  es: /Se envió una copia/,
  fr: /Une copie a été envoyée/,
  de: /Eine Kopie ging/,
  it: /Una copia è stata inviata/,
  nl: /Er ging een kopie/,
  pt: /Foi enviada uma cópia/,
};

globalThis.fetch = async () => { throw new Error("No external fetch is allowed in this proof"); };

async function main() {
  for (const language of LANGUAGE_CODES) {
    const store = { handle: "sample", name: "Sample", email: "creator@example.test", language, currency: "usd" } as unknown as Store;
    const agreement = { id: "a".repeat(32), kind: "agreement", name, email: "signer@example.test", copies: 0, sent: [], failed: "", versions: [] } as unknown as Agreement;
    const version = { n: 1, currency: "usd", title: "Sample record", text: "Synthetic text only" } as AgreementVersion;
    const signature = { name, at: 1_800_000_000_000, sha256: "b".repeat(64), consent: "Synthetic consent", ipHash: "" } as Signature;
    state.agreement = agreement;
    const result = await sendSignedCopies(store, agreement, version, signature);
    is(`${language}: real sender function confirms neither copy was sent`, result, { signer: false, creator: false });
    const message = agreementWords(language).signedBody(name, date);
    is(`${language}: the recorded signer and date stay in the displayed sentence`, [message.includes(name), message.includes(date)], [true, true]);
    is(`${language}: a refused sender cannot justify the past-tense copy-sent claim`, mailedClaim[language].test(message), false);
  }
  is("both synthetic sender attempts occurred once per language", state.attempts, 14);
  is("the real sender preserves its explicit failure and never increments copies", [state.agreement?.copies, Boolean(state.agreement?.failed)], [0, true]);
  const route = readFileSync("app/api/store/agreement-sign/route.ts", "utf8");
  const page = readFileSync("app/[handle]/sign/[agreement]/page.tsx", "utf8");
  is("the existing route returns signed after attempting the copies", route.indexOf('return back("signed")') > route.indexOf("await sendSignedCopies"), true);
  is("the existing page displays signedBody from signature name/date without sender result", page.includes("w.signedBody(signature.name, said.date(signature.at))"), true);
  done();
}
void main();
