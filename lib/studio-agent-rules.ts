/**
 * The assistant inside the studio, the agent that does the work and waits for
 * the creator's yes (631 [AA1], unit 7, with 27 [E10]; owner, 2 November
 * 2026, 02h15 Fortaleza, and 10 November 2026: "all of Whop's AI, and
 * better"). Unit 1: the rules of one turn, pure and browser-safe. No route,
 * no screen and no model call yet: the next unit runs a turn by these rules.
 *
 * What the rules guarantee, whoever builds on them:
 *
 *   - The assistant only reaches the store through the MCP server's own tools
 *     (lib/mcp-catalog.ts), and only through the ones named here. A tool
 *     added to the server later is not offered until it gets a row here: an
 *     unnamed tool is never in a turn, rather than in by default.
 *   - Each tool is offered only to a person whose role may do the same in
 *     the studio (lib/team-roles.ts), by the permission of the studio screen
 *     it stands for. A teammate's assistant never reaches more than they do.
 *   - Reading is all a tool does, or it prepares a change ("propose"): what
 *     is there now and what it would become, kept in the book of proposals
 *     (lib/agent-proposal-rules.ts) until the creator confirms it in the
 *     studio. Nothing the assistant calls publishes, sends, charges, refunds
 *     or deletes, and no tool can confirm, undo or decline: carrying a change
 *     out is only ever the creator's own press (CARRIED_OUT_BY).
 *   - A tool whose read-only hint says it writes, but is not a "propose"
 *     tool, is never offered, whatever its row says.
 *   - Before the first model call, the whole turn's most possible cost is
 *     worked out from the one table of list prices (lib/spend-cost-table.ts,
 *     Anthropic's published prices read 2026-10-17): every call of the turn,
 *     each with all the input it may carry and all the output it may write.
 *     That sum is what the turn reserves in the store's monthly AI budget
 *     (lib/ai-spend.ts) before anything is asked. A cost the table cannot
 *     bound, or a budget left that could not be read, refuses the turn: an
 *     unknown is never zero.
 *   - A turn is bounded: the creator's message, the instructions, each tool's
 *     answer and what the model writes all have a most, and so does the
 *     number of tool steps. What would go past them is refused or cut, said
 *     so, never sent past the ceiling the turn reserved.
 */
import { MCP_TOOLS } from "@/lib/mcp-catalog";
import { isSupportedAiModel } from "@/lib/ai-request-rules";
import { type AiRequestShape, aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import type { Permission } from "@/lib/team-roles";

/** What a tool does for the assistant: it reads, or it prepares a change the creator confirms. */
export type AgentToolReach = "read" | "propose";

/**
 * A tool the assistant may use: what it does and the studio permissions a
 * person must hold for it ("member": anyone on the store's team).
 */
export type StudioAgentTool = { reach: AgentToolReach; needs: readonly (Permission | "member")[] };

/**
 * Every MCP tool the assistant in the studio may use, with the permission of
 * the studio screen it stands for (the screens' routes ask the same: the
 * numbers ask "stats", products and courses "products", the page's versions
 * and saved sections "page", the emails "draft").
 */
export const STUDIO_AGENT_TOOLS: Readonly<Record<string, StudioAgentTool>> = {
  get_store: { reach: "read", needs: ["member"] },
  get_numbers: { reach: "read", needs: ["stats"] },
  get_revenue_by_channel: { reach: "read", needs: ["stats"] },
  get_funnel: { reach: "read", needs: ["stats"] },
  get_product_numbers: { reach: "read", needs: ["stats"] },
  get_buyers: { reach: "read", needs: ["stats"] },
  get_worth_knowing: { reach: "read", needs: ["stats"] },
  get_memberships: { reach: "read", needs: ["stats"] },
  get_affiliates: { reach: "read", needs: ["stats"] },
  get_page_test: { reach: "read", needs: ["stats"] },
  get_page_reading: { reach: "read", needs: ["stats"] },
  list_products: { reach: "read", needs: ["products"] },
  get_product_description: { reach: "read", needs: ["products"] },
  get_sales_page: { reach: "read", needs: ["products"] },
  get_course_outline: { reach: "read", needs: ["products"] },
  get_lesson: { reach: "read", needs: ["products"] },
  get_page_versions: { reach: "read", needs: ["page"] },
  list_saved_blocks: { reach: "read", needs: ["page"] },
  get_emails: { reach: "read", needs: ["draft"] },
  propose_product_description: { reach: "propose", needs: ["products"] },
};

/** Who carries a prepared change out: the creator, pressing confirm in the studio. Never the assistant. */
export const CARRIED_OUT_BY = "creator_press" as const;

/** Words a tool's name may never hold for the assistant: each would act on its own instead of preparing. */
export const ACTING_WORDS = /(^|_)(confirm|undo|decline|apply|execute|send|publish|refund|charge|pay|delete|erase|remove|invite)(_|$)/;

/** What one person may do in the studio, as lib/team-roles.ts `can` answers it for their role. */
export type Can = (permission: Permission) => boolean;

/**
 * The tools offered in one turn, for one person: named here, served by the
 * MCP server, of the reach their read-only hint says, and allowed to that
 * person's role. In the server's order.
 */
export function studioAgentTools(can: Can, served: readonly { name: string; annotations: { readOnlyHint: boolean } }[] = MCP_TOOLS): string[] {
  return served
    .filter((tool) => {
      if (!Object.hasOwn(STUDIO_AGENT_TOOLS, tool.name)) return false;
      const row = STUDIO_AGENT_TOOLS[tool.name];
      if (ACTING_WORDS.test(tool.name)) return false;
      const fits = row.reach === "read" ? tool.annotations.readOnlyHint === true : tool.annotations.readOnlyHint === false && tool.name.startsWith("propose_");
      return fits && row.needs.every((need) => need === "member" || can(need));
    })
    .map((tool) => tool.name);
}

/** The model a turn runs on: the answering model, which reads and prepares; the creator decides on every change. */
export const STUDIO_AGENT_MODEL = "claude-haiku-5-5";

/** The most of one turn, in bytes of text unless said otherwise. */
export const TURN_LIMITS = {
  /** The instructions and the list of tools offered. */
  systemBytes: 6_144,
  /** The creator's message. */
  askBytes: 2_000,
  /** One tool's answer, as carried back to the model; a longer one is cut and the model told so. */
  toolResultBytes: 4_096,
  /** The model's own tool call, carried back with its answer. */
  toolCallBytes: 1_024,
  /** Tool steps in one turn; then the model answers with what it has. */
  toolSteps: 2,
  /** Tokens the model may write in one call. */
  outputTokens: 800,
} as const;

/** The model calls of a turn: one, and one more after each tool step. */
export const TURN_CALLS = TURN_LIMITS.toolSteps + 1;

/** The most the `step`-th call of a turn (0 first) may carry and write: all earlier tool steps ride along. */
export function callShape(step: number): AiRequestShape {
  const carried = step * (TURN_LIMITS.toolResultBytes + TURN_LIMITS.toolCallBytes);
  return { inputBytes: TURN_LIMITS.systemBytes + TURN_LIMITS.askBytes + carried, blocks: 1 + 2 * step, media: null, maxTokens: TURN_LIMITS.outputTokens };
}

/**
 * The most a whole turn can cost, in micro-USD: the sum of each of its calls
 * at its most (lib/spend-cost-table.ts). Null when the table cannot bound one
 * of them, or the model is not one the studio may call.
 */
export function turnHoldMicroUsd(model: string = STUDIO_AGENT_MODEL): number | null {
  if (!isSupportedAiModel(model)) return null;
  let total = 0;
  for (let step = 0; step < TURN_CALLS; step += 1) {
    const hold = aiRequestHoldMicroUsd(model, callShape(step));
    if (hold === null || !Number.isSafeInteger(hold) || hold <= 0) return null;
    total += hold;
  }
  return Number.isSafeInteger(total) ? total : null;
}

export type TurnRefusal = "too_long" | "cost_unknown" | "budget_unknown" | "no_budget";

/**
 * Whether a turn may start, and what it reserves first. `askBytes` is the
 * creator's message (UTF-8); `budgetLeftMicroUsd` what the store's monthly AI
 * budget has left, or null when it could not be read. The turn starts only
 * when its whole most fits in what is left; otherwise nothing is asked.
 */
export function planTurn(askBytes: number, budgetLeftMicroUsd: number | null, model: string = STUDIO_AGENT_MODEL): { ok: true; model: string; calls: number; holdMicroUsd: number } | { ok: false; why: TurnRefusal } {
  if (!Number.isSafeInteger(askBytes) || askBytes < 1 || askBytes > TURN_LIMITS.askBytes) return { ok: false, why: "too_long" };
  const hold = turnHoldMicroUsd(model);
  if (hold === null) return { ok: false, why: "cost_unknown" };
  if (budgetLeftMicroUsd === null || !Number.isSafeInteger(budgetLeftMicroUsd) || budgetLeftMicroUsd < 0) return { ok: false, why: "budget_unknown" };
  if (budgetLeftMicroUsd < hold) return { ok: false, why: "no_budget" };
  return { ok: true, model, calls: TURN_CALLS, holdMicroUsd: hold };
}

export type StepRefusal = "not_offered" | "too_many_steps";

/**
 * Whether the model's `step`-th tool call (0 first) in a turn may run: only a
 * tool offered in this turn, and no more than TURN_LIMITS.toolSteps of them.
 * A "propose" tool only prepares: its answer says the change waits for the
 * creator, and the turn never carries it out.
 */
export function gateStep(tool: string, offered: readonly string[], step: number): { ok: true; reach: AgentToolReach; waitsForCreator: boolean } | { ok: false; why: StepRefusal } {
  if (!Number.isSafeInteger(step) || step < 0 || step >= TURN_LIMITS.toolSteps) return { ok: false, why: "too_many_steps" };
  if (!offered.includes(tool) || !Object.hasOwn(STUDIO_AGENT_TOOLS, tool)) return { ok: false, why: "not_offered" };
  const reach = STUDIO_AGENT_TOOLS[tool].reach;
  return { ok: true, reach, waitsForCreator: reach === "propose" };
}

/**
 * A tool's answer as carried back to the model: whole when it fits in
 * TURN_LIMITS.toolResultBytes, otherwise cut on a character and marked, so
 * the turn never carries more than it reserved.
 */
export function carriedAnswer(text: string): { text: string; cut: boolean } {
  const bytes = new TextEncoder();
  if (bytes.encode(text).length <= TURN_LIMITS.toolResultBytes) return { text, cut: false };
  const mark = "\n[The rest of this answer was left out: it was longer than the assistant may read in one step.]";
  const room = TURN_LIMITS.toolResultBytes - bytes.encode(mark).length;
  let kept = "";
  let used = 0;
  for (const char of text) {
    const size = bytes.encode(char).length;
    if (used + size > room) break;
    kept += char;
    used += size;
  }
  return { text: kept + mark, cut: true };
}

/** The creator's words for a refused turn, in plain US English. */
export const TURN_REFUSALS: Readonly<Record<TurnRefusal, string>> = {
  too_long: `Your message is too long for the assistant. Keep it under ${TURN_LIMITS.askBytes.toLocaleString("en-US")} characters.`,
  cost_unknown: "The assistant could not work out the most this would cost, so it did not start. Nothing was used.",
  budget_unknown: "The assistant could not read how much of this month's AI budget is left, so it did not start. Nothing was used.",
  no_budget: "This month's AI budget does not have enough left for the assistant. Nothing was used.",
};
