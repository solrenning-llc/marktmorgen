// Codex M's proof on #3156 (privacy review of 6ca884273, tests/m-reactivation-during-check.proof.ts, blob 376bb54f), kept
// byte for byte beside this file and run as a discovered test with its assertions unchanged: a store whose plan runs
// again while the closing walk's final check of whether it is due waits on its reads is not erased, nor its contacts.
import "./m-reactivation-during-check.proof";
