import { answerStudioDemoOpen, studioDemoNotFound } from "@/lib/studio-demo";

/**
 * The studio demo's door (queue item 256 [KJ1], unit 2; docs/studio-demo.md).
 *
 * POST opens a demo session. While STUDIO_DEMO_ON is false it answers 404,
 * as a path that does not exist, without reading the body or Redis; nothing
 * links here. GET and DELETE are not built yet and answer the same 404.
 */
export async function POST(request: Request) {
  return answerStudioDemoOpen(request);
}

export async function GET() {
  return studioDemoNotFound();
}

export async function DELETE() {
  return studioDemoNotFound();
}
