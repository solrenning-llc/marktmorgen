// Codex M's proof on #3156 (privacy review of 6ca884273, tests/m-erasure-concurrent.proof.ts, blob 7e0bce24), kept byte
// for byte beside this file and run as a discovered test with its assertions unchanged: a replacement first store its
// owner opens after the closing walk read that no store holds the closed store's key, but before the walk deletes the
// keys named by it, keeps its pause, its last pause and its folder's owner.
import "./m-erasure-concurrent.proof";
