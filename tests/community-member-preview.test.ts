/**
 * "Which spaces a member sees" in the studio (399 [SL3], unit 2; added
 * 1 November 2026; components/community-member-preview.tsx). Checked:
 *
 *   - the panel works out its list with previewSpaces, the rule the real gate
 *     uses, from the community the studio already has, and nothing else;
 *   - it reads no buyer, calls no route, changes nothing and tells nobody;
 *   - its line says how many of the spaces such a member sees, lists them
 *     (with their place when two share a name), says plainly when it is
 *     none, and asks for a product when nothing is picked;
 *   - it says what it does not show (posts and events), so it never stands
 *     in for something it is not;
 *   - the products to pick are those that open the community, as visible
 *     checkboxes in a group with a legend, and the result is announced.
 */
import { readFileSync } from "node:fs";
import { GONE_PRODUCT, PREVIEW_LEAVES_OUT, previewLine, previewName } from "@/lib/community-gate";
import { done, is, part } from "./check";

part("The line");
is("nothing checked is not a member: it asks for a product", previewLine(0, 0, 4), "Check what a member bought to see which spaces they would see.");
is("some of the spaces", previewLine(1, 2, 4), "A member with these products sees 2 of your 4 spaces:");
is("all of them", previewLine(2, 2, 2), "A member with these products sees all 2 of your spaces:");
is("the only space is said as such, never \"all 1\"", previewLine(1, 1, 1), "A member with these products sees your only space.");
is("none is said plainly", previewLine(1, 0, 2), "A member with these products sees none of your spaces.");
const named = [{ id: "a", name: "Wins" }, { id: "b", name: "Questions" }, { id: "c", name: "Wins" }];
is("a name two spaces share carries each one's place", [previewName(named, "a"), previewName(named, "b"), previewName(named, "c")], ["Wins (space 1)", "Questions", "Wins (space 3)"]);
is("what it leaves out is said", PREVIEW_LEAVES_OUT, "This shows which spaces they see, not the posts in them. Events have their own rule and are not shown here. Nothing is changed and nobody is told.");

part("The panel");
const panel = readFileSync("components/community-member-preview.tsx", "utf8");
is("its list comes from the same rule as the real gate", panel.includes("previewSpaces(spaces, access, picked)"), true);
is("it reads no buyer and calls nothing", /fetch\(|useRouter|\/api\/|email|stripe/i.test(panel), false);
is("its products are the ones that open the community, as checkboxes in a group with a legend", panel.includes("<fieldset") && panel.includes("<legend") && panel.includes('type="checkbox"') && panel.includes("pick.map("), true);
is("the result is announced politely, with the line", panel.includes('aria-live="polite"') && panel.includes("previewLine("), true);
is("it says what it does not show", panel.includes("PREVIEW_LEAVES_OUT"), true);
is("shown only when some space is kept for some products, and some product opens the community", panel.includes("if (!access.length || !spaces.some((space) => space.only.length)) return null;"), true);
is("every product that opens the community can be checked, one no longer in the store too", panel.includes("access.map((id) => open.find((product) => product.id === id) ?? { id, title: GONE_PRODUCT })") && GONE_PRODUCT === "A product no longer in your store", true);
is("a checked product taken off the community's list no longer counts", panel.includes("const picked = chosen.filter((id) => access.includes(id));") && panel.includes("previewSpaces(spaces, access, picked)"), true);
is("the spaces are a list, each named with its place when names repeat", panel.includes("<ul") && panel.includes("previewName(spaces, space.id)"), true);
const studio = readFileSync("components/community-studio.tsx", "utf8");
is("the studio shows it under the spaces, with the community's own spaces, access and the open products", studio.includes("<MemberPreview spaces={config.spaces} access={config.access} open={open} />"), true);
done();
