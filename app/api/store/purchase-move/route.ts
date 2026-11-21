import type { NextRequest } from "next/server";
import { askMoveRoute } from "@/lib/purchase-move-flow";

// The longest one ask may run: a few reads and writes, then two emails, one after the other.
export const maxDuration = 30;

/** A buyer asks to move their purchases to another email (611 [WP10]): lib/purchase-move-flow.ts. */
export async function POST(request: NextRequest) {
  return askMoveRoute(request);
}
