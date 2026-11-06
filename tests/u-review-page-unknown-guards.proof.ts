import { readFile } from "node:fs/promises";
import { join } from "node:path";

let checks = 0;
function is(name: string, actual: unknown, expected: unknown): void {
  checks += 1;
  if (actual !== expected) throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`);
}

async function main(): Promise<void> {
  const [assistant, kit, product] = await Promise.all([
    readFile(join(process.cwd(), "lib/store-assistant.ts"), "utf8"),
    readFile(join(process.cwd(), "lib/affiliate-kit.ts"), "utf8"),
    readFile(join(process.cwd(), "app/[handle]/p/[product]/page.tsx"), "utf8"),
  ]);

  const assistantRead = assistant.indexOf("await readAssistantFacts(store).catch(() => null)");
  const assistantReject = assistant.indexOf('if (facts === null) return { ok: false, reason: "failed" }');
  const assistantRequest = assistant.indexOf("const request = assistantRequest(store, facts, before, text)");
  const assistantReserve = assistant.indexOf('await pool("reserve"');
  is("assistant reads the complete facts before preparing a request", assistantRead >= 0 && assistantRead < assistantRequest, true);
  is("assistant rejects an unknown page before preparing a request", assistantReject > assistantRead && assistantReject < assistantRequest, true);
  is("assistant rejects an unknown page before reserving model money", assistantReject < assistantReserve, true);

  const kitRead = kit.indexOf("kitPageRead(store, product)");
  const kitMarksUnread = kit.indexOf('if (page === "unread") unread = true');
  const kitModel = kit.indexOf("else posts = await writeAffiliatePosts");
  const kitUnreadGuard = kit.indexOf("if (unread)", kitModel);
  const kitGiveBack = kit.indexOf("await giveBack();", kitUnreadGuard);
  const kitReturn = kit.indexOf('return { ok: false, reason: "unavailable" }', kitUnreadGuard);
  is("affiliate kit reads the sales page before model generation", kitRead >= 0 && kitRead < kitModel, true);
  is("affiliate kit does not generate posts for an unknown page", kitMarksUnread > kitRead && kitMarksUnread < kitModel, true);
  is("affiliate kit gives its counters back before returning unavailable", kitUnreadGuard > kitModel && kitGiveBack > kitUnreadGuard && kitGiveBack < kitReturn, true);

  const productUnknown = product.indexOf('if (savedPage === "unread")');
  const productVariant = product.indexOf("const page = await shownVersion");
  is("public product page handles an unknown page before choosing an A/B version", productUnknown >= 0 && productUnknown < productVariant, true);
  is("public product page marks the explanation as status text", product.indexOf('<p role="status"', productUnknown) > productUnknown, true);
  is("public product page offers the localized store return link", product.indexOf("w.backTo(store.name)", productUnknown) > productUnknown, true);

  console.log(`${checks} checks passed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
