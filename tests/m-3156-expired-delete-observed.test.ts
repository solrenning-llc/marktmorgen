// Codex M's proof on #3156 (focal review of 86775eaa8, tests/m-3156-expired-delete-observed.proof.ts, SHA256 4cabdc83,
// blob 6179cdde), kept byte for byte beside this file: the closing walk's lock runs out while it deletes the store's
// team, the store's plan runs again in that moment, and the store that runs again keeps its team. Before the fix it ran
// here unchanged: 6 checks, 1 failing. Run now through tests/m-3156-expired-delete-fenced.proof.ts, the same proof with
// its pause found also at the fenced delete (CLOSING_FENCED): once every delete is fenced there is no bare DEL of the
// team for the frozen copy to pause at, and it fails only on reaching its pause. Assertions unchanged.
import "./m-3156-expired-delete-fenced.proof";
