import { answerCarryPreview, answerForgetPreview } from "@/lib/store-preview-keep";

/**
 * A store preview kept 24 hours (488 [IT5] unit 4; docs/it5-store-preview.md). POST carries it, once, into the studio
 * of the person signed in with its cookie; DELETE deletes it at once. While STORE_PREVIEW_ON is false both answer 404.
 */
export async function POST(request: Request) {
  return answerCarryPreview(request);
}

export async function DELETE(request: Request) {
  return answerForgetPreview(request);
}
