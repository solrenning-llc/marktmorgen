/**
 * Which spaces a member sees, as one pure rule (399 [SL3], unit 1,
 * lib/community-gate.ts; added 1 November 2026). Checked: open, kept for
 * products, a product off the community's list shutting nobody out; the
 * preview with chosen products sees exactly what such a member would; the
 * real gate (lib/community-access.ts maySeeSpace) uses the same rule; the
 * preview reads no buyer and asks nothing of Stripe.
 */
import { readFileSync } from "node:fs";
import { previewSpaces, seesSpace, spaceGate } from "@/lib/community-gate";
import { done, is, part } from "./check";

const access = ["course", "coaching"];
const spaces = [
  { id: "general", only: [] as string[] },
  { id: "students", only: ["course"] },
  { id: "clients", only: ["coaching"] },
  { id: "old", only: ["retired"] },
  { id: "either", only: ["course", "coaching"] },
];

part("The gate");
is("kept for nobody: open", spaceGate(spaces[0], access), { open: true });
is("kept for a product: needs it", spaceGate(spaces[1], access), { open: false, needs: ["course"] });
is("kept only for a product off the community's list: open, nobody shut out", spaceGate(spaces[3], access), { open: true });
is("kept for one product on the list and one off it: needs the one on it", spaceGate({ id: "mixed", only: ["retired", "course"] }, access), { open: false, needs: ["course"] });
is("one of several is enough", [seesSpace(spaces[4], access, new Set(["coaching"])), seesSpace(spaces[2], access, new Set(["course"]))], [true, false]);

part("View as a member");
is("a member who bought nothing that keeps a space", previewSpaces(spaces, access, []).map((s) => s.id), ["general", "old"]);
is("a member of the course", previewSpaces(spaces, access, ["course"]).map((s) => s.id), ["general", "students", "old", "either"]);
is("a member of both", previewSpaces(spaces, access, ["course", "coaching"]).map((s) => s.id), ["general", "students", "clients", "old", "either"]);
is("a product picked that does not open the community changes nothing", previewSpaces(spaces, access, ["retired"]).map((s) => s.id), ["general", "old"]);
is("the creator's order is kept", previewSpaces([spaces[4], spaces[0]], access, ["course"]).map((s) => s.id), ["either", "general"]);

part("One rule for both");
const gate = readFileSync("lib/community-access.ts", "utf8");
is("the real gate uses the same rule (a structural check of the source; the behavior is the gate tested above)", gate.includes("const gate = spaceGate(space, config.access);") && gate.includes("if (gate.open) return true;"), true);
const pure = readFileSync("lib/community-gate.ts", "utf8").replace(/^\s*\*.*$/gm, "");
is("the preview reads no buyer and asks nothing of anyone", /import |fetch\(|email|redis|stripe/i.test(pure), false);
done();
