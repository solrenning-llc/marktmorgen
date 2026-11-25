import type { NextRequest } from "next/server";
import { stopMeta } from "@/lib/meta-routes";

/**
 * Disconnects the store's Meta ad account. It gives the permission back to Meta
 * only when no other store is confirmed to use the same Meta login (lib/meta-routes.ts, lib/meta-ads.ts disconnectMeta).
 */
export async function POST(request: NextRequest) {
  return stopMeta(request);
}
