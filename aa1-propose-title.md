631 [AA1] (c), stacked on #1856: two more changes an AI agent may prepare for the creator to confirm, with the same book, confirmation, batch and undo as the description.

- `propose_product_title` and `propose_product_summary` (MCP): checked first with the studio's own word rules for a product on the store (no promise of fast or easy money, 567 [GD1] (d); no ready-outline prompt left in), then kept beside what is there now.
- Confirming writes that field alone (`setProductTitle`, `setProductSummary` in `lib/store.ts`): price, terms and everything else stay. Undo puts it back.
- The studio's list names them ("Title of …", "Summary of …"); /developers counts twenty-four tools, three of which prepare a change.

## Tests
`tests/agent-propose-title.test.ts` (17, real MCP and studio routes), plus `agent-propose`, `agent-confirm`, `mcp-dispatch`, `mcp-read-tools`, `numbers-three`, `llms-txt`, `agent-coverage`; typecheck, lint, public data, US English.

## Acessibilidade
- Criteria checked: 3.1.5 (plain labels "Title of …", "Summary of …" and the /developers sentence); 3.3.6 (nothing changes until the creator confirms; undo afterward); the proposals screen itself is unchanged from #1856.
- Method: diff reading; no new control or state.
- Not covered: no assistive-technology run.
- Steps/decisions: 0 → 0 for the creator (the same confirm screen).

## VR
State: tested in a PR. Built on #1856, which is not merged yet.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxxg2hUJABFFutG88Tb
