602 [WP1] unit 2: the buyer's mark drawn over lesson videos, off by default (rebased on main; its PR had not been opened).

- `Course.stampVideo` (optional, read only when true) decides it; nothing can switch it on yet (unit 3, the studio's switch).
- The lesson page draws `components/video-stamp.tsx` over both players (the video service's and a plain file) only for the signed-in student, with their own email and the day they joined; never for the creator or a preview visitor.
- The mark moves between places in the top of the video every `MOVE_SECONDS`, and stays still for `prefers-reduced-motion` and on the server.

No cost (drawn in the browser), no new data kept, no price, limit, commission, flag or gate changed.

## Tests
`tests/video-stamp-player.test.ts`, `tests/video-stamp.test.ts`; accessibility inventory, US English, typecheck, lint, public data.

## Acessibilidade
- Criteria checked: 2.3.3 and 2.2.2 (the movement is a jump every few seconds, never animated, and none at all with reduced motion); 2.3.2 (nothing flashes); 1.3.1/4.1.2 (`aria-hidden`, not focusable, `pointer-events: none`, so it never takes a click or a focus stop and never repeats the student's own email to a screen reader); 1.4.6: the mark is treated as incidental text (a deterrent over the picture, not content), so it is deliberately faint; recorded here as a judgment for the accessibility review, not a measured pass.
- Method: diff reading and the tests' render checks; no screen reader or browser run.
- Not covered: forced-colors not checked; no test with people (item 202).
- Steps/decisions for the student: 0 → 0 (nothing to do).

## VR
State: tested in a PR; switched off for every course until unit 3 adds the creator's switch.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxxg2hUJABFFutG88Tb
