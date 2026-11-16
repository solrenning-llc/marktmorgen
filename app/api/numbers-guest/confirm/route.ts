import type { NextRequest } from "next/server";
import { pressLink, showLink } from "@/lib/report-guests-page";

/**
 * The confirm link of the numbers email to an address outside a store's team
 * (405 [HX1], lib/report-guests-page.ts). Public: the link carries only its
 * token. A GET shows one button and changes nothing; the POST does it.
 */
export async function GET(request: NextRequest) {
  return showLink("confirm", request);
}

export async function POST(request: NextRequest) {
  return pressLink("confirm", request);
}
