/**
 * 568 [GD2] (c), unit 3: a store's name and description never read as Marktmorgen's own.
 *
 * The name is at the top of every page of a store and is the sender's name on its emails, so a store called
 * "Marktmorgen Support" or "Markt Morgen" is the easiest way to pass for us. An address with the name in it is already
 * refused (lib/store.ts, newAddressProblem); now, with the real routes on the in-memory database and a real session:
 *
 *   - the rule alone (lib/brand-imitation-rules.ts, storeImitation): a name with the name in it, look-alike letters
 *     included, is refused; a description is read with unit 1's rule; ordinary names and "runs on Marktmorgen" pass;
 *   - making a store (app/api/store/claim): refused with "brand_imitation" and its field, and the address stays free;
 *   - saving the details (app/api/store/details): refused, and the name and description stay as they were;
 *   - the AI store setup's chosen line (lib/store-setup.ts) is not kept when it poses;
 *   - both forms say why, in plain words, and that nothing was made or saved.
 *
 * Synthetic store and data only.
 */
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, storeForEmail, storeForHandle } from "@/lib/store";
import { STORE_IMITATION_MESSAGE, storeImitation } from "@/lib/brand-imitation-rules";
import { keepStoreSetup } from "@/lib/store-setup";
import { POST as claim } from "@/app/api/store/claim/route";
import { POST as details } from "@/app/api/store/details/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";

async function main(): Promise<void> {
  part("The rule alone");
  const refusedNames = ["Marktmorgen", "Marktmorgen Support", "Markt Morgen Help", "MARKT-MORGEN", "Marktm0rgen Store", "Rnarktmorgen"];
  is("a name with our name in it is refused", refusedNames.map((name) => storeImitation({ name, bio: "" })?.field), refusedNames.map(() => "name"));
  is("a description that poses is refused", storeImitation({ name: "Ada's Bakery", bio: "Regards, The Marktmorgen Team" })?.field, "bio");
  const fine = [
    { name: "Ada's Bakery", bio: "Sourdough classes. My store runs on Marktmorgen." },
    { name: "Morgen Market", bio: "" },
    { name: "Markt & Co", bio: "Prints." },
    { name: "Night Recipes", bio: "Marktmorgen emails you a link to your library." },
  ];
  is("ordinary names and saying where the store runs pass", fine.map((store) => storeImitation(store)), fine.map(() => null));
  is("anything not text is nothing found", storeImitation({ name: null, bio: 7 }), null);

  part("Making a store");
  redis.clear();
  const owner = "store.name@example.com";
  const session = await openSession(owner);
  const post = (path: string, body: unknown, cookie = session) =>
    new NextRequest(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${cookie}` },
      body: JSON.stringify(body),
    });
  const answer = async (response: Response) => {
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; field?: string };
    return [response.status, data.ok === true ? "ok" : data.error ?? "", data.field ?? ""];
  };
  const named = await answer(await claim(post("/api/store/claim", { handle: "adabakes", name: "Marktmorgen Support", bio: "" })));
  is("a store named as Marktmorgen is refused, saying the field", named, [409, "brand_imitation", "name"]);
  const lined = await answer(await claim(post("/api/store/claim", { handle: "adabakes", name: "Ada Bakes", bio: "Your Marktmorgen account has been suspended." })));
  is("so is one whose line poses", lined, [409, "brand_imitation", "bio"]);
  is("no store was made and the address is still free", [await storeForEmail(owner), await storeForHandle("adabakes")], [null, null]);

  part("Saving the details");
  const other = "details.name@example.com";
  await claimHandle(other, "nightrecipes", "Night Recipes", "Ten dinners.");
  const otherSession = await openSession(other);
  const renamed = await answer(await details(post("/api/store/details", { name: "Markt Morgen Help", bio: "Ten dinners." }, otherSession)));
  is("a name that reads as ours is refused", renamed, [409, "brand_imitation", "name"]);
  const relined = await answer(await details(post("/api/store/details", { name: "Night Recipes", bio: "Enter your Marktmorgen password to open the recipes." }, otherSession)));
  is("a line that poses is refused", relined, [409, "brand_imitation", "bio"]);
  const kept = await storeForEmail(other);
  is("and the name and line stay as they were", [kept?.name, kept?.bio], ["Night Recipes", "Ten dinners."]);
  const plain = await answer(await details(post("/api/store/details", { name: "Night Recipes", bio: "Ten dinners, on Marktmorgen." }, otherSession)));
  is("a plain change is saved", plain, [200, "ok", ""]);

  part("The AI store setup's chosen line");
  const before = await storeForEmail(other);
  const setup = await keepStoreSetup(other, before!, { bio: "Regards, The Marktmorgen Team", products: [] });
  is("a line that poses is not kept", [setup.bio, (await storeForEmail(other))?.bio], [false, "Ten dinners, on Marktmorgen."]);

  part("Both forms say why");
  const message = STORE_IMITATION_MESSAGE;
  is("the words say what and what to do", [/reads as Marktmorgen's own/.test(message), /Use a name of your own/.test(message)], [true, true]);
  is("the store form says no store was made", /brand_imitation: `\$\{STORE_IMITATION_MESSAGE\} No store was made\.`/.test(readFileSync("components/handle-form.tsx", "utf8")), true);
  is("the details form says nothing was saved", /brand_imitation: `\$\{STORE_IMITATION_MESSAGE\} Nothing was saved\.`/.test(readFileSync("components/details-form.tsx", "utf8")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
