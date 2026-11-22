/** Observe the real mark key in either the former SET or the store-fenced script; do not fake a SET in the log. */
export function summaryClaimKey(command: (string | number)[]): string {
  if (command[0] === "SET" && command.includes("NX")) return String(command[1]);
  if (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:summary-live:v1\n") && command[12] === "claim") return String(command[5]);
  return "";
}
