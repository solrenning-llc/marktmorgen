import { updatesWords } from "@/lib/buyer-words/updates";
import { LANGUAGE_CODES, LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { render } from "@/lib/mail";
import { claimHandle, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const AFTER: Record<LanguageCode, string> = {
  en: "from Harbor Kitchen. Open the link, then confirm on the page.",
  es: "de Harbor Kitchen. Abre el enlace y confirma en la página.",
  fr: "de Harbor Kitchen. Ouvrez le lien, puis confirmez sur la page.",
  de: "von Harbor Kitchen. Öffnen Sie den Link und bestätigen Sie auf der Seite.",
  it: "da Harbor Kitchen. Apri il link e conferma nella pagina.",
  nl: "van Harbor Kitchen. Open de link en bevestig op de pagina.",
  pt: "de Harbor Kitchen. Abra a ligação e confirme na página.",
};

async function main(): Promise<void> {
  redis.clear();
  globalThis.fetch = (async () => { throw new Error("No provider request expected"); }) as typeof fetch;
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  const original = (await storeForEmail("owner@example.com"))!;
  const page = "https://example.com/unsubscribe?u=synthetic";
  const oneClick = "https://example.com/api/mail/unsubscribe?u=synthetic";
  part("The email body link needs page confirmation; the mailbox header remains one-click");
  for (const code of LANGUAGE_CODES) {
    const words = updatesWords(code);
    const after = words.stopAfter(original.name);
    const result = render({ ...original, language: code }, "Update", "A new version is available.", null, {
      page, oneClick, why: words.why("Guide", original.name), label: words.stopLabel,
      after, line: words.stopLine(page), lang: LANGUAGES[code].locale,
    });
    is(`${code}: footer explains both existing actions`, after, AFTER[code]);
    is(`${code}: actual HTML includes that instruction`, result.html.includes(AFTER[code]), true);
    is(`${code}: body link still opens the confirmation page`, result.html.includes(`href="${page}"`), true);
    is(`${code}: plain text keeps the same opt-out page`, result.text.includes(page), true);
    is(`${code}: mailbox opt-out endpoint remains unchanged`, result.headers["List-Unsubscribe"], `<${oneClick}>`);
    is(`${code}: mailbox one-click protocol remains unchanged`, result.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    is(`${code}: HTML retains the existing locale`, result.html.includes(`<html lang="${LANGUAGES[code].locale}">`), true);
  }
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
