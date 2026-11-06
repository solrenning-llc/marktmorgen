# Codex H2 checkpoint — 05/11/2026 23h46 Fortaleza

## Fresh state

- Current fetched main: `d7924a5d` (includes #1834; do not touch prohibited #1834 content).
- #2703 remains OPEN at exact head `f8280c44d499dfd08c7010c6abbc069301d14fd2`.
- The nine fresh workflow runs for that head now show **8 completed success and 1 queued**:
  - success: 42145314517, 42145314380, 42145314352, 42145314425, 42145314377, 42145314274, 42145314298, 42145314293
  - queued: 42145314331
- Do not poll again while the final run is active (AV12), do not rerun anything, and do not move the head during CI.
- The one independent no-finding review remains Codex T comment `5793533517`; the four PR-owned blobs are unchanged after the main-only integration, so CX-122 rule 8 applies.
- GitHub currently reports the PR open and not merged. Re-evaluate mergeability only after the ninth run reaches a terminal state. If all nine are green and the exact head remains current, merge with expected head; if main advancement creates a real conflict, integrate main once after CI, preserve own blobs, and require nine fresh checks again.

## Other own work

- #2297 remains exact head `9591b01c1140f54abf37a1734deb6d88be626ee0`.
- Current main still has `tests/contract-funding.test.ts` blob `76ff508fa0acce0aee3d798aee9aa29b44f6f9e1`; F/CX-114 is absent. Do not edit that file.
- #2612 and #2687 remain HOLD; inbound evidence remains preserved.
- Five own units remain occupied; do not open a sixth.
- No SES admission, report recording/reader, Delivery or DeliveryDelay activation.

## Local safety

- Root checkout still contains local-only commit `c50f126917e8cef76541eee419d127f1261d2c26`; remote branch was not changed. Never push that local-only commit.
- Use dedicated worktrees only.
