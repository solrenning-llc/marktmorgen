/**
 * A sales page's picture described for someone who cannot see it (lib/ai.ts,
 * describePicture). The model is played by a stand-in for `fetch`. Checked:
 * the picture goes as an image of its own type with the product's name; the
 * store's language and the rules (only what is seen, no names or results)
 * are said; the answer comes back as one clean line no longer than a
 * description may be, counted as a month's job; a picture too large is
 * refused before the model is asked. The studio only sends a picture from
 * the store's own folder.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_DESCRIBED_BYTES, describePicture } from "@/lib/ai";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let reply = "";
const asked: { system: string; content: unknown }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  const body = JSON.parse(String(init?.body)) as { system: string; messages: { content: unknown }[] };
  asked.push({ system: body.system, content: body.messages[0].content });
  return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }));
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail("owner@example.com"))!;

  part("What is sent");
  reply = "“Una hogaza de centeno cortada sobre una tabla de madera.”";
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const done1 = await describePicture(store, { bytes, mediaType: "image/webp", productTitle: "Sunday Baking", language: "Spanish" });
  const content = asked[0].content as { type: string; source?: { media_type: string; data: string }; text?: string }[];
  is("the picture, as an image of its own type", [content[0].type, content[0].source?.media_type, content[0].source?.data], ["image", "image/webp", Buffer.from(bytes).toString("base64")]);
  is("with the product's name", content[1].text?.includes("Sunday Baking"), true);
  is("told the language and to say only what is seen", [asked[0].system.includes("Write in Spanish"), asked[0].system.includes("Describe only what can be seen"), asked[0].system.includes("Never name a person")], [true, true, true]);

  part("What comes back");
  is("one clean line, its quotes taken off", done1.ok ? done1.value : null, "Una hogaza de centeno cortada sobre una tabla de madera.");
  is("counted as one of the month's jobs", done1.ok ? done1.left : null, 39);
  reply = "A".repeat(400);
  const long = await describePicture(store, { bytes, mediaType: "image/jpeg", productTitle: "Sunday Baking", language: "English" });
  is("never longer than a description may be", long.ok ? long.value.length : null, 150);

  part("What is refused");
  const before = asked.length;
  const big = await describePicture(store, { bytes: new Uint8Array(MAX_DESCRIBED_BYTES + 1), mediaType: "image/jpeg", productTitle: "x", language: "English" });
  is("a picture too large, before the model is asked", [big.ok, asked.length], [false, before]);
  const route = readFileSync("app/api/store/ai/route.ts", "utf8");
  is("only a picture from the store's own folders", route.includes("const folders = await pictureFolders(store);\n    if (!path || !folders.some((folder) => ownsImagePath(path, folder))) return fail(\"invalid\");"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
