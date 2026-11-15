/**
 * "Every video has captions and a transcript" in the page coach (AX274 Part A item 6; ATAG 2.0 Part B): the studio
 * helps the creator give each video on a sales page an alternative (WCAG 1.2.2 Captions; 1.2.8 Media Alternative,
 * AAA), and never writes one for them. The course editor's caption check (lib/course-access-check.ts) is the model.
 *
 * A page's videos are kept at YouTube, Vimeo or Loom (lib/sales-page.ts, Video): Marktmorgen cannot add captions
 * there, nor know whether they are on, and an unknown is never called fine. So what is checked is what the page
 * itself holds: a transcript right under each video, as a "text" block whose heading starts with "Transcript", with
 * words in it. The captions are asked of the creator in words only.
 *
 * Read only from the blocks the editor already has: no read, no cost. Pure, so it can be tested, and safe in the
 * browser. Not a conformity claim: nothing here says a page is accessible.
 */
import type { PageBlock, VideoProvider } from "@/lib/sales-page";

/** The heading the fix gives the transcript block, and the one a transcript is known by (any case, more words after). */
export const TRANSCRIPT_HEADING = "Transcript";

/** One video on the page, with the block it sits in and the state of the transcript right under that block. */
export type PageVideo = {
  /** The block holding the video: the top of the page, a video block, or a row of columns. */
  blockId: string;
  provider: VideoProvider;
  /** "none": the next block is not a transcript; "empty": it is one with no words yet; "written": it has words. */
  transcript: "none" | "empty" | "written";
};

const isTranscript = (block: PageBlock | undefined): block is Extract<PageBlock, { kind: "text" }> =>
  block?.kind === "text" && /^transcript\b/i.test(block.heading.trim());

/** Every video the page shows, in page order: the top's (when it shows a video), each video block's, each in a row. */
export function pageVideos(blocks: readonly PageBlock[]): PageVideo[] {
  const out: PageVideo[] = [];
  blocks.forEach((block, at) => {
    const next = blocks[at + 1];
    const transcript: PageVideo["transcript"] = isTranscript(next) ? (next.body.trim() ? "written" : "empty") : "none";
    if (block.kind === "hero" && block.media === "video" && block.video) out.push({ blockId: block.id, provider: block.video.provider, transcript });
    else if (block.kind === "video" && block.video) out.push({ blockId: block.id, provider: block.video.provider, transcript });
    else if (block.kind === "row") {
      for (const element of block.columns.flat()) {
        if (element.kind === "video" || element.kind === "video-window") out.push({ blockId: block.id, provider: element.video.provider, transcript });
      }
    }
  });
  return out;
}
