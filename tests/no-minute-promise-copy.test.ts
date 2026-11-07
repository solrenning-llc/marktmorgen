/**
 * Sending a link can prove that one request was handed to the email sender,
 * never when the message reaches the buyer's inbox (VR 2: nothing promised
 * that cannot be kept). Every buyer-facing sentence that promised arrival
 * "within a minute" keeps its instructions and loses the deadline, the same
 * way tests/waitlist-delivery-copy.test.ts holds waitSentBody (#2593):
 *
 *   - the expired review link's "ask again" line (lib/buyer-words/giving.ts);
 *   - the affiliate sign-in link (lib/buyer-words/affiliates.ts);
 *   - the private podcast's feed link (lib/buyer-words/courses.ts);
 *   - the sign-in page (components/signin-form.tsx);
 *   - the one email to imported buyers (lib/imports.ts, movedEmail).
 *
 * Each is checked as the complete sentence, in every language it is shown in,
 * and a sweep of the three word sets keeps the deadline from coming back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { coursesWords } from "@/lib/buyer-words/courses";
import { givingWords } from "@/lib/buyer-words/giving";
import { grantImported } from "@/lib/imported-purchases";
import { movedEmail, type ImportJob } from "@/lib/imports";
import { addProduct, claimHandle, ensureStatsId, setPastBuyers, storeForEmail } from "@/lib/store";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const S = "\u00a0";

const RECOVER: Record<LanguageCode, string> = {
  en: "Ask for your purchases again: a new link is emailed to you, and you can review from there.",
  es: "Vuelve a pedir tus compras: te enviamos un enlace nuevo por email, y desde ahí puedes dejar tu reseña.",
  fr: `Redemandez vos achats${S}: un nouveau lien vous est envoyé par e-mail, et vous pourrez laisser votre avis depuis celui-ci.`,
  de: "Fordern Sie Ihre Käufe erneut an: Ein neuer Link wird Ihnen per E-Mail geschickt, und von dort aus können Sie bewerten.",
  it: "Richiedi di nuovo i tuoi acquisti: ti inviamo un nuovo link via email, e da lì puoi lasciare la recensione.",
  nl: "Vraag je aankopen opnieuw op: we sturen je een nieuwe link per e-mail, en van daaruit kun je een beoordeling schrijven.",
  pt: "Peça novamente as suas compras: é-lhe enviada uma nova ligação por email, e pode avaliar a partir daí.",
};

const AFFILIATE: Record<LanguageCode, string> = {
  en: "The link is on its way. It comes from Harbor Kitchen via Marktmorgen. If it is not there, look in spam.",
  es: "El enlace va en camino. Llega de Harbor Kitchen a través de Marktmorgen. Si no está, mira en spam.",
  fr: "Le lien est en route. Il vient de Harbor Kitchen via Marktmorgen. S'il n'est pas là, regardez dans les spams.",
  de: "Der Link ist unterwegs. Er kommt von Harbor Kitchen über Marktmorgen. Falls er nicht da ist, sehen Sie im Spam-Ordner nach.",
  it: "Il link è in arrivo. Viene da Harbor Kitchen tramite Marktmorgen. Se non c'è, guarda nello spam.",
  nl: "De link is onderweg. Hij komt van Harbor Kitchen via Marktmorgen. Staat hij er niet, kijk dan in je spam.",
  pt: "A ligação está a caminho. Vem de Harbor Kitchen através da Marktmorgen. Se não estiver lá, veja no spam.",
};

const PODCAST: Record<LanguageCode, string> = {
  en: "If that address has this podcast, a link to its own feed is on its way. It comes from the store via Marktmorgen. If it is not there, look in spam.",
  es: "Si esa dirección tiene este pódcast, va en camino un enlace a su propio feed. Lo envía la tienda a través de Marktmorgen. Si no está, mira en spam.",
  fr: "Si cette adresse possède ce podcast, un lien vers son propre flux est en route. Il vient de la boutique via Marktmorgen. S'il n'est pas là, regardez dans les spams.",
  de: "Wenn zu dieser Adresse dieser Podcast gehört, ist ein Link zu ihrem eigenen Feed unterwegs. Er kommt vom Shop über Marktmorgen. Falls er nicht da ist, sehen Sie im Spam nach.",
  it: "Se quell'indirizzo ha questo podcast, un link al suo feed personale è in arrivo. Lo invia il negozio tramite Marktmorgen. Se non c'è, guarda nello spam.",
  nl: "Als dat adres deze podcast heeft, is er een link naar een eigen feed onderweg. Die komt van de winkel via Marktmorgen. Staat hij er niet, kijk dan bij spam.",
  pt: "Se esse endereço tem este podcast, uma ligação para o seu próprio feed está a caminho. É enviada pela loja através da Marktmorgen. Se não estiver lá, veja no spam.",
};

/** An arrival deadline in any of the seven languages. */
const DEADLINE = /within a minute|in under a minute|menos de un minuto|moins d'une minute|innerhalb einer Minute|entro un minuto|binnen een minuut|menos de um minuto/i;

/** Every string a word set can show, its functions called with sample text. */
function strings(value: unknown, path: string, out: [string, string][], skip: Set<string>): void {
  const key = path.split(".").pop() ?? "";
  if (skip.has(key)) return;
  if (typeof value === "string") out.push([path, value]);
  else if (typeof value === "function") {
    const args = Array.from({ length: Math.max(value.length, 1) }, () => "Harbor Kitchen");
    try {
      strings((value as (...a: unknown[]) => unknown)(...args), path, out, skip);
    } catch {
      // A function that needs numbers or objects is not a sentence about email arrival.
    }
  } else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}.${i}`, out, skip));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out, skip);
}

async function main(): Promise<void> {
  part("The expired review link's way back promises no arrival time");
  for (const code of LANGUAGE_CODES) {
    is(`${code}: complete sentence`, givingWords(code).expiredRecover, RECOVER[code]);
  }

  part("The affiliate link's status promises no arrival time");
  for (const code of LANGUAGE_CODES) {
    const text = affiliatesWords(code).sentBody("Harbor Kitchen");
    is(`${code}: complete sentence`, text, AFFILIATE[code]);
    is(`${code}: keeps the store and spam guidance`, [text.includes("Harbor Kitchen"), /spam/i.test(text)], [true, true]);
  }

  part("The podcast feed link's status promises no arrival time");
  for (const code of LANGUAGE_CODES) {
    const text = coursesWords(code).podcastNotices.sent.body;
    is(`${code}: complete sentence`, text, PODCAST[code]);
    is(`${code}: keeps the spam guidance`, /spam/i.test(text), true);
  }

  part("No sentence in these word sets promises an arrival time");
  // waitSentBody is held by tests/waitlist-delivery-copy.test.ts (#2593).
  const skip = new Set(["waitSentBody"]);
  for (const code of LANGUAGE_CODES) {
    const found: [string, string][] = [];
    strings(givingWords(code), "giving", found, skip);
    strings(affiliatesWords(code), "affiliates", found, skip);
    strings(coursesWords(code), "courses", found, skip);
    is(`${code}: sentences read`, found.length > 100, true);
    is(`${code}: none with a deadline`, found.filter(([, text]) => DEADLINE.test(text)).map(([path]) => path), []);
  }

  part("The sign-in page asks to look in spam without a deadline");
  const signin = readFileSync(join(process.cwd(), "components/signin-form.tsx"), "utf8");
  is("the complete sentence is shown", signin.includes(`<p className="mt-3 text-sm text-ink-soft">Not there? Look in spam or promotions.</p>`), true);
  is("no deadline anywhere on the form", DEADLINE.test(signin), false);

  part("The one email to imported buyers promises no arrival time");
  redis.clear();
  const owner = "owner@example.com";
  const buyer = "buyer@example.com";
  is("store made", (await claimHandle(owner, "harbor-kitchen", "Harbor Kitchen", "")).ok, true);
  await ensureStatsId(owner);
  await setPastBuyers(owner);
  const made = await addProduct(owner, "The Bread Book", "Bread at home", "29", null);
  if (!made.ok) throw new Error("product not made");
  const store = (await storeForEmail(owner))!;
  const jobId = "a".repeat(24);
  is("purchase brought over", await grantImported(store.statsId!, jobId, [{ email: buyer, productId: made.product.id, items: null }], 1793293200, store.sid), [true]);
  const mail = await movedEmail(store, { id: jobId } as ImportJob, buyer);
  const base = `https://marktmorgen.com/@harbor-kitchen`;
  const line = (mail?.text ?? "").split("\n").find((l) => l.startsWith("To open")) ?? "";
  is(
    "the complete instruction line",
    line,
    `To open it, go to ${base}/orders and type ${buyer}. A link to everything you have there is emailed to you. There is no password to make.`,
  );
  is("no deadline anywhere in the email", DEADLINE.test(mail?.text ?? ""), false);

  done();
}

void main();
