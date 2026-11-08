// Codex M's proof on #3156 (focal review of 86775eaa8, tests/m-3156-expired-delete-observed.proof.ts, SHA256 4cabdc83,
// blob 6179cdde), kept byte for byte beside this file and run as a discovered test with its assertions unchanged: the
// closing walk's lock runs out while it deletes the store's team, the store's plan runs again in that moment, and the
// store that runs again keeps its team.
import "./m-3156-expired-delete-observed.proof";
