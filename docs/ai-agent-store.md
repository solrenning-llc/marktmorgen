# The whole store run by an AI agent: 631 [AA1], in units

Owner's request, 2 November 2026, 02h15 Fortaleza (full text in `docs/codex-queue.md`, item 631): everything a creator does in the studio can be done by an AI agent, more safely, more clearly and more easily than Whop's command line; the site's AI can generate code and the customer knows it; nothing is shown to a customer before it works (rule VR). Built by Claude 3 (branches `claude3/`), one small pull request per unit, files reserved first in [docs/reservations.md](reservations.md).

## The measure: every studio action, and how the agent reaches it

[`lib/agent-coverage.ts`](../lib/agent-coverage.ts) lists every studio route under `app/api` (a route that passes one of the studio's own guards), once per method, with one of:

- **tool**: an MCP tool already does it;
- **read**, **draft** or **execute**: not built yet, and the kind of agent key it will need under 631 (c). A *draft* is a change the agent prepares as a before-and-after preview that the creator confirms; *execute* reaches people outside the studio or cannot be taken back, so it is confirmed one at a time;
- **never**, with the reason: money is never moved by the agent; who is let in, secrets and files of buyers' addresses never pass through an assistant's conversation; a page another service sends the browser back to has nothing to call.

`tests/agent-coverage.test.ts` reads the route files and fails when a studio route or method has no row, when a row names a route that is gone, when a named tool is not served by `app/api/mcp/route.ts`, or when a money route is anything but "never".

State on 2 November 2026 (units 1 to 11): 176 studio actions. 6 are tools today (the store's numbers, live and today, any stretch of days, a product's description, its sales page, a course's outline and lessons); 14 are planned reads, 97 planned drafts, 15 planned executions; 44 are never, with their reason (unit 11 moved license keys, students' hand-ins, customers' words and dispute reviews there). The MCP server also has read tools with no studio route of their own (revenue by channel, the funnel, memberships, emails, affiliates, buyers in numbers, what is worth knowing).

## Units

State words as in rule VR: on the queue, in progress, tested in a PR, merged, published, available to the customer, switched off by the gates.

1. **Coverage inventory** (this file, `lib/agent-coverage.ts`, its test). Tested in a PR.
2. **Proposals, confirmation and undo** (631 (c)): one store of prepared changes with before and after, confirmed one at a time or in a batch, each confirmed change in a history "What the AI did" with who asked, when, what changed, and undo where the kind allows it. No route or screen yet. On the queue.
3. **Agent keys by scope**: read, draft and execute keys, revocable at once, beside the existing read and write keys (`lib/api-keys.ts`). On the queue.
4. **First write tools on the MCP server** (27 [E10], 258 [KJ3]): the page's own words and parts, as drafts that wait for the creator's confirmation, reusing `lib/api-write.ts`. On the queue.
5. **The studio screen** for proposals and the history, WCAG 2.2 AAA (AX274). On the queue.
6. **The other areas**, in the order of the table: products, courses, calls, offers, email drafts, community, podcast, affiliates, settings. On the queue.
7. **The assistant inside the studio**, in plain words, every model call reserved first inside the plan's AI work, with a monthly ceiling per store. On the queue.
8. **Command line and documentation for agents** (616 [WP15](24), 614 [WP13]): `llms.txt` and Markdown generated from the code. On the queue.
9. **Generated code** (631 (d)): blocks, interactive parts and small apps, run on a separate apps domain with a strict content security policy, checked before publishing (third-party scripts, imitation of login, checkout or brand, password or card collection, AAA accessibility). On the queue.
10. **The public page** (631 (e)) only after units 2–9 work, with a dated comparison and no claim of superiority without the proof AX274 item 7 asks for. On the queue.
11. **Connector listing package** (631 (f), 616 [WP15](25)): ready to submit; submitting needs the owner's own accounts. Found on 2 November 2026 (Anthropic's submission and authentication pages, read in full, no date shown): Anthropic's directory asks for OAuth 2.0 for a service that acts on a user's account, and a title and a read-only or destructive hint on every tool (titles added in unit 8). OpenAI's directory seems to ask the same (search summaries only, not confirmed). So the listing needs OAuth on the MCP server first; the server's static key stays for the API, the command line and Cursor. On the queue.

Built beside the plan above, in this order: unit 4 is the check of generated code, unit 5 `/llms.txt`, unit 6 the command line, unit 7 the isolation rules for generated apps, units 8 to 10 read tools (live and any days; description and sales page; course outline and lessons), unit 11 this table brought up to date. Proposals still wait for their storage (`tests/store-data-registry.ts` and `lib/data-families.ts` are in open Codex PRs).

Costs (631, "Custo"): every model call reserved before it is made, inside the plan's AI work, with a monthly ceiling per store; generated apps count in the plan's storage and visits, with a ceiling before the cost; API reads and writes inside the plan's requests. Unknown cost fails, never zero. No price, visible limit, commission, `PLANS_ON_SALE`, `OPENING_REQUESTED` or gate changes for this item.
