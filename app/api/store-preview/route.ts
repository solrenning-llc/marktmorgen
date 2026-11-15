import { answerStorePreview, storePreviewNotFound } from "@/lib/store-preview-door";

/**
 * The store preview's door (488 [IT5] unit 3a; docs/it5-store-preview.md). POST makes one writing job of a preview
 * before an account. While STORE_PREVIEW_ON is false it answers 404, as a path that does not exist, without reading
 * the body or the database; nothing links here.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  return answerStorePreview(request);
}

export async function GET() {
  return storePreviewNotFound();
}
