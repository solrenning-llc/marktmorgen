/**
 * One paid order whose confirmation throws never holds back the store's other orders (Claude 4, C4-2990, P3).
 *
 * The proof is Claude 4's, kept byte for byte in ./checkout-sweep-block-proof.ts (branch claude4/sweep-proofs @
 * 50aaccab, proofs/c4-sweeps/stripehand/p3-sweep-block.proof.ts): the real sweep on the in-memory Redis, order A's
 * confirmation claim throwing on three runs, then a control run without the throw. It only prints what it saw; this
 * file reads those lines and holds them. Before the per-order catch, A's throw ended the store's pass: B, the older
 * order behind it, was never confirmed while the throw lasted, and the run said nothing had failed.
 */
import { done, is, part } from "./check";

const lines: string[] = [];
const print = console.log;
console.log = (...args: unknown[]) => {
  lines.push(String(args[0]));
  print(...args);
};

function seen(prefix: string): Record<string, string> {
  const line = lines.find((l) => l.startsWith(prefix)) ?? "";
  return Object.fromEntries([...line.matchAll(/([A-Za-z.]+(?: sent)?)=("[^"]*"|\S+)/g)].map((m) => [m[1], m[2]]));
}

async function main(): Promise<void> {
  await import("./checkout-sweep-block-proof");
  const until = Date.now() + 60_000;
  while (!lines.some((l) => l.startsWith("control")) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  console.log = print;

  part("Order A's confirmation throws on three runs");
  for (const run of [1, 2, 3]) {
    const got = seen(`run ${run}:`);
    is(`run ${run}: A is not confirmed, and B, behind it, is (once, on the first run)`, [got["A sent"], got["B sent"]], ["0", "1"]);
    is(`run ${run}: B counted as confirmed on the run that sent it, and A counted as failed`, [got["counts.confirmed"], got["counts.failed"]], [run === 1 ? "1" : "0", "1"]);
    is(`run ${run}: the store's pass did not end on A`, got.logged === "\"reading a store's checkouts failed\"", false);
  }
  part("A's throw gone: A, kept pending, is confirmed on the next run");
  is("A sent once, B still once, one confirmed", Object.values(seen("control")), ["1", "1", "1"]);
  done();
}

void main();
