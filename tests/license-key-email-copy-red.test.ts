/**
 * Evidence only: a key that was waiting is put on the buyer's order before
 * its email is attempted. The sender may refuse that attempt, so the seven
 * buyer languages must not promise that the email arrives. No product code
 * is changed by this branch.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setProductKeys, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { addKeys, keyForSale, keyOfSale } from "@/lib/licence-keys";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { ordersWords } from "@/lib/buyer-words/orders";
import { givingWords } from "@/lib/buyer-words/giving";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "key-mail-copy@example.test";
const BUYER = "buyer@example.test";
const SALE = `cs_test_${"m".repeat(24)}`;

const cautious: Record<LanguageCode, [string, string]> = {
  en: ["try to email", "may not arrive"],
  es: ["intentamos enviarla por email", "puede no llegar"],
  fr: ["essayons de vous l’envoyer par e-mail", "peut ne pas arriver"],
  de: ["versuchen, ihn Ihnen per E-Mail zu schicken", "kommt möglicherweise nicht an"],
  it: ["proviamo a inviartela via email", "potrebbe non arrivare"],
  nl: ["proberen hem naar je te e-mailen", "komt misschien niet aan"],
  pt: ["tentamos enviá-la por email", "pode não chegar"],
};

const durable: Record<LanguageCode, [string, string]> = {
  en: ["here", "list of purchases"],
  es: ["aquí", "lista de compras"],
  fr: ["ici", "liste d'achats"],
  de: ["hier", "Liste der Käufe"],
  it: ["qui", "elenco di acquisti"],
  nl: ["hier", "lijst met aankopen"],
  pt: ["aqui", "lista de compras"],
};

// The stand-in Redis does not implement LPOP. Model its one-list-item result
// with the same LINDEX + LTRIM effect used by the existing key tests.
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (!commands.some((command) => command[0] === "LPOP")) return realPipeline(commands);
  const answers: unknown[] = [];
  for (const command of commands) {
    if (command[0] !== "LPOP") {
      answers.push(...(await realPipeline([command])));
      continue;
    }
    const [first] = await realPipeline([["LINDEX", command[1], 0]]);
    if (first !== null && first !== undefined) await realPipeline([["LTRIM", command[1], 1, -1]]);
    answers.push(first ?? null);
  }
  return answers;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  part("All three buyer messages distinguish durable access from an email attempt");
  for (const language of LANGUAGE_CODES) {
    const o = ordersWords(language);
    const g = givingWords(language);
    const messages = [o.keyWaiting("North Star"), o.keyOnItsWay(o.yourKey, "North Star"), g.keyWaiting("North Star")];
    for (const [index, message] of messages.entries()) {
      is(`${language}: message ${index + 1} says the email is attempted and may not arrive`, cautious[language].every((word) => message.includes(word)), true);
    }
    is(`${language}: the durable orders-page access stays explicit`, durable[language].every((word) => messages[0].includes(word)), true);
  }

  part("The real waiting-key path keeps access when the real sender refuses");
  redis.clear();
  delete process.env.RESEND_API_KEY;
  delete process.env.AMAZON_SES_ACCESS_KEY_ID;
  delete process.env.AWS_ACCESS_KEY_ID;
  await claimHandle(OWNER, "keymailcopy", "North Star", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Desktop app", "", "29", null);
  if (!made.ok) throw new Error("product was not made");
  is("the pool setup is accepted", (await setProductKeys(OWNER, made.product.id, { ...DEFAULT_KEYS, source: "pool" })).ok, true);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readProduct(store, made.product.id))!;
  is("an empty pool records the buyer as waiting", (await keyForSale(store, product, SALE, BUYER))?.state, "waiting");
  const added = await addKeys(store, product, ["AAAA-BBBB-CCCC-DDDD"]);
  const issued = await keyOfSale(store, product, SALE);
  is("adding a key serves the waiting buyer even with no configured sender", [added.served, issued?.state, issued?.state === "issued" ? issued.key : ""], [1, "issued", "AAAA-BBBB-CCCC-DDDD"]);

  const source = readFileSync("lib/licence-keys.ts", "utf8");
  const serve = source.slice(source.indexOf("async function serveWaiting"));
  is("delivery is recorded before the email attempt and sender rejection is absorbed", serve.indexOf("served += 1") < serve.indexOf("await sendEmail") && serve.includes(".catch((error) => console.error(\"emailing a waiting buyer their key failed\""), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
