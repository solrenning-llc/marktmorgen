/**
 * A file played in place is media (the security audit of 14 November 2026, LOW). signedMedia (lib/learn.ts) hands
 * the browser a signed storage address with no name to save under, so the browser shows the file in the tab with
 * the type it was stored with: for a lesson's video and a podcast episode. A sold file may be an SVG or any other
 * type of ALLOWED_TYPES, and one put where a video or an episode goes would open as a page of its own on the
 * storage's address. Now only a file stored as video or audio (or, for an old record with no type kept, named as
 * one) is signed to play in place; anything else gets no address, and nothing is counted as delivered.
 *
 * The storage is the synthetic Blob world (tests/blob-download-attachment-world.ts); Redis is the in-memory one.
 */
import { signedMedia } from "@/lib/learn";
import { monthKey } from "@/lib/delivery";
import { redisPipeline } from "@/lib/redis";
import type { ProductFile } from "@/lib/product-file";
import { resetBlobWorld } from "./blob-download-attachment-world";
import { done, is, part } from "./check";

const FOLDER = "0123456789abcdef0123456789abcdef";
const file = (name: string, contentType: string): ProductFile => ({ pathname: `stores/${FOLDER}/prod01/${name}`, name, bytes: 1_000, contentType, addedAt: "" });
const delivered = async () => Number((await redisPipeline([["GET", `nl:store:delivery:${FOLDER}:${monthKey()}`]]))[0] ?? 0);
const signs = async (f: ProductFile) => typeof (await signedMedia(f, 300)) === "string";

async function main(): Promise<void> {
  resetBlobWorld();
  part("Video and audio play in place, as before");
  for (const [name, type] of [["lesson.mp4", "video/mp4"], ["lesson.mov", "video/quicktime"], ["lesson.webm", "video/webm"], ["episode.mp3", "audio/mpeg"], ["episode.m4a", "audio/mp4"], ["episode.wav", "audio/wav"]] as const) {
    is(`${type}: signed`, await signs(file(name, type)), true);
  }
  part("An old record with no type kept plays when its name is a video's or an episode's");
  is("lesson.mp4, no type: signed", await signs(file("lesson.mp4", "")), true);
  is("episode.mp3, no type: signed", await signs(file("episode.mp3", "")), true);

  part("Anything else gets no address to open in the tab");
  const before = await delivered();
  for (const [name, type] of [["guide.svg", "image/svg+xml"], ["page.html", "text/html"], ["guide.pdf", "application/pdf"], ["photo.png", "image/png"], ["guide.svg", ""], ["clip.mp4", "image/svg+xml"], ["noname", ""]] as const) {
    is(`${name}, ${type || "no type"}: not signed`, await signs(file(name, type)), false);
  }
  is("and nothing is counted as delivered for them", (await delivered()) - before, 0);
  done();
}

void main();
