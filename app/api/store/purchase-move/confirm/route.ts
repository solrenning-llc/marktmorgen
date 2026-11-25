import type { NextRequest } from "next/server";
import { confirmMoveRoute } from "@/lib/purchase-move-flow";

// The longest one confirmation may run: a few reads and one mark.
export const maxDuration = 15;

/** One address confirms a move of purchases, by the link emailed to it (611 [WP10]): lib/purchase-move-flow.ts. */
export async function POST(request: NextRequest) {
  return confirmMoveRoute(request);
}
