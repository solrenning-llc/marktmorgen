// Synthetic world: the real lib/buyer-actions, with takeBuyerRead counting what it is asked for against a fixed
// number of requests left (no store window is read).
export * from "../lib/buyer-actions";
import type { Store } from "../lib/store";

export const counted: { asked: number[]; left: number } = { asked: [], left: Number.MAX_SAFE_INTEGER };

export async function takeBuyerRead(_store: Store, units = 1): Promise<boolean> {
  counted.asked.push(units);
  if (units > counted.left) return false;
  counted.left -= units;
  return true;
}
