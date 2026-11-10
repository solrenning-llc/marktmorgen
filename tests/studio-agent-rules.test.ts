/**
 * The rules of one turn of the assistant inside the studio (631 [AA1] (studio assistant),
 * unit 1; lib/studio-agent-rules.ts). Pure; the real MCP tool list
 * (lib/mcp-catalog.ts), the real role table (lib/team-roles.ts) and the real
 * price table (lib/spend-cost-table.ts). Checked:
 *
 *   - every tool named here is one the MCP server serves, and the server's
 *     real tools are offered at the reach their read-only hint says;
 *   - each role gets exactly the tools of the studio screens it may use;
 *   - a tool the server adds later, one whose hint says it writes, or one
 *     whose name acts on its own, is never offered;
 *   - no offered tool confirms, undoes, sends, charges or deletes, and a
 *     "propose" step waits for the creator;
 *   - the turn's most is the sum of every call at its most, worked out before
 *     the first call; a cost or a budget that cannot be read refuses, a budget
 *     one micro-dollar short refuses, never zero;
 *   - a step past the most, or a tool not offered, is refused;
 *   - a long tool answer is cut to the turn's bound on a whole character.
 */
import {
  ACTING_WORDS, CARRIED_OUT_BY, STUDIO_AGENT_MODEL, STUDIO_AGENT_TOOLS, TURN_CALLS, TURN_LIMITS, TURN_REFUSALS,
  callShape, carriedAnswer, gateStep, planTurn, studioAgentTools, turnHoldMicroUsd,
} from "@/lib/studio-agent-rules";
import { MCP_TOOLS } from "@/lib/mcp-catalog";
import { can, type Role } from "@/lib/team-roles";
import { aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import { done, is, part } from "./check";

const as = (role: Role) => (p: Parameters<typeof can>[1]) => can(role, p);
const served = MCP_TOOLS.map((t) => t.name);
const rows = Object.keys(STUDIO_AGENT_TOOLS);

part("The tools named here are the server's own");
is("every row names a tool the MCP server serves", rows.filter((name) => !served.includes(name)), []);
is(
  "each served tool's read-only hint is the reach its row says (read: read-only; propose: writes, as a proposal)",
  MCP_TOOLS.filter((t) => rows.includes(t.name)).filter((t) => (STUDIO_AGENT_TOOLS[t.name].reach === "read") !== t.annotations.readOnlyHint).map((t) => t.name),
  [],
);
is("the propose tools are named so", rows.filter((n) => STUDIO_AGENT_TOOLS[n].reach === "propose"), ["propose_product_description"]);
is("no row's name acts on its own", rows.filter((n) => ACTING_WORDS.test(n)), []);

part("Each person gets what their role may do in the studio");
const owner = studioAgentTools(as("owner"));
is("the owner: every named tool the server serves, in its order", owner, served.filter((n) => rows.includes(n)));
is("an admin: the same as the owner (numbers, products, page, emails)", studioAgentTools(as("admin")), owner);
is(
  "an editor: the same too (an editor has stats, products, page and draft)",
  studioAgentTools(as("editor")),
  owner,
);
is("support (orders, community, reviews): only which store this is", studioAgentTools(as("support")), ["get_store"]);
const noStats = (p: Parameters<typeof can>[1]) => p !== "stats" && can("owner", p);
is("a role without the numbers gets no numbers tool", studioAgentTools(noStats).filter((n) => STUDIO_AGENT_TOOLS[n].needs.includes("stats")), []);
is("and still the rest", studioAgentTools(noStats).includes("propose_product_description"), true);
const noProducts = (p: Parameters<typeof can>[1]) => p !== "products" && can("owner", p);
is("a role without products may not propose a product's words", studioAgentTools(noProducts).includes("propose_product_description"), false);

part("Never offered: an unnamed tool, a writing hint, an acting name");
const synthetic = [
  { name: "get_numbers", annotations: { readOnlyHint: true } },
  { name: "get_secret_settings", annotations: { readOnlyHint: true } },
  { name: "get_sales_page", annotations: { readOnlyHint: false } },
  { name: "propose_product_description", annotations: { readOnlyHint: true } },
  { name: "confirm_proposal", annotations: { readOnlyHint: false } },
  { name: "send_email", annotations: { readOnlyHint: false } },
];
is(
  "of a server that grew: only the named read tool is offered (a new tool waits for its row; a read row served as writing, or a propose row served as read-only, is left out)",
  studioAgentTools(as("owner"), synthetic),
  ["get_numbers"],
);
is(
  "the acting words are caught wherever they stand in a name",
  ["confirm_proposal", "undo_change", "decline_proposal", "apply_change", "execute", "send_email", "publish_page", "refund_order", "charge_card", "pay_out", "delete_product", "erase_person", "remove_member", "invite_teammate", "get_sent_emails"].map((n) => ACTING_WORDS.test(n)),
  [true, true, true, true, true, true, true, true, true, true, true, true, true, true, false],
);
is("nothing offered to the owner confirms, undoes, sends, charges or deletes", owner.filter((n) => ACTING_WORDS.test(n)), []);
is("a change is carried out only by the creator's own press", CARRIED_OUT_BY, "creator_press");

part("The turn's most, worked out before the first call");
const sum = Array.from({ length: TURN_CALLS }, (_, step) => aiRequestHoldMicroUsd(STUDIO_AGENT_MODEL, callShape(step)) as number).reduce((a, b) => a + b, 0);
is("a turn is one call and one more after each tool step", TURN_CALLS, TURN_LIMITS.toolSteps + 1);
is(
  "the last call carries the instructions, the message and every tool step before it",
  callShape(TURN_LIMITS.toolSteps).inputBytes,
  TURN_LIMITS.systemBytes + TURN_LIMITS.askBytes + TURN_LIMITS.toolSteps * (TURN_LIMITS.toolResultBytes + TURN_LIMITS.toolCallBytes),
);
is("every call may write the whole output", Array.from({ length: TURN_CALLS }, (_, s) => callShape(s).maxTokens), Array(TURN_CALLS).fill(TURN_LIMITS.outputTokens));
is("the hold is every call at its most, from the price table", [turnHoldMicroUsd(), turnHoldMicroUsd() === sum, sum > 0], [sum, true, true]);
is("each later call costs more than the one before (all earlier steps ride along), so none is priced as the first", Array.from({ length: TURN_CALLS - 1 }, (_, s) => (aiRequestHoldMicroUsd(STUDIO_AGENT_MODEL, callShape(s + 1)) as number) > (aiRequestHoldMicroUsd(STUDIO_AGENT_MODEL, callShape(s)) as number)), Array(TURN_CALLS - 1).fill(true));
is("the writing model is priced too, and dearer", (turnHoldMicroUsd("claude-sonnet-5-5") as number) > sum, true);
is("a model the studio may not call has no price: null, never zero", [turnHoldMicroUsd("gpt-x"), turnHoldMicroUsd("")], [null, null]);

part("Whether a turn may start");
is("a fitting message with the budget exactly enough: starts, reserving the whole turn", planTurn(120, sum), { ok: true, model: STUDIO_AGENT_MODEL, calls: TURN_CALLS, holdMicroUsd: sum });
is("one micro-dollar short: nothing is asked", planTurn(120, sum - 1), { ok: false, why: "no_budget" });
is("a budget that could not be read: refused, never taken as enough", [planTurn(120, null), planTurn(120, -1), planTurn(120, Number.NaN), planTurn(120, 1.5)], Array(4).fill({ ok: false, why: "budget_unknown" }));
is("a model with no price: refused before the budget is looked at", planTurn(120, 10 ** 12, "gpt-x"), { ok: false, why: "cost_unknown" });
is("an empty message or one past the most: refused", [planTurn(0, sum), planTurn(TURN_LIMITS.askBytes + 1, sum), planTurn(TURN_LIMITS.askBytes, sum).ok], [{ ok: false, why: "too_long" }, { ok: false, why: "too_long" }, true]);
is("every refusal has words for the creator, and says nothing was used when nothing was", Object.entries(TURN_REFUSALS).map(([k, w]) => [k, w.length > 20, k === "too_long" || w.includes("Nothing was used.")]), [["too_long", true, true], ["cost_unknown", true, true], ["budget_unknown", true, true], ["no_budget", true, true]]);

part("Each tool step");
is("a read tool offered: runs, nothing waits", gateStep("get_numbers", owner, 0), { ok: true, reach: "read", waitsForCreator: false });
is("a propose tool: runs, and its change waits for the creator", gateStep("propose_product_description", owner, 1), { ok: true, reach: "propose", waitsForCreator: true });
is("a tool not offered to this person: refused", gateStep("get_numbers", ["get_store"], 0), { ok: false, why: "not_offered" });
is("a tool the server does not have, even if listed as offered: refused", gateStep("confirm_proposal", ["confirm_proposal"], 0), { ok: false, why: "not_offered" });
is("past the most steps, or a step that is not a count: refused", [gateStep("get_numbers", owner, TURN_LIMITS.toolSteps), gateStep("get_numbers", owner, -1), gateStep("get_numbers", owner, 0.5)], Array(3).fill({ ok: false, why: "too_many_steps" }));

part("A tool's answer as carried back");
is("a short answer goes whole", carriedAnswer("Sales today: 3"), { text: "Sales today: 3", cut: false });
const long = carriedAnswer("é".repeat(TURN_LIMITS.toolResultBytes));
const size = new TextEncoder().encode(long.text).length;
is("a long one is cut to the bound, marked, and never splits a character", [long.cut, size <= TURN_LIMITS.toolResultBytes, long.text.includes("�"), long.text.endsWith("longer than the assistant may read in one step.]")], [true, true, false, true]);
is("an answer exactly at the bound goes whole", carriedAnswer("a".repeat(TURN_LIMITS.toolResultBytes)).cut, false);

done();
