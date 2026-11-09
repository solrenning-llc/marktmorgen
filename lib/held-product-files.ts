/**
 * Every file a product hands over, for the child-safety hold (unit 3b,
 * lib/held-files.ts): its own file, each price option's file, its picture
 * and the picture's smaller copy, the pictures on its sales page, each
 * lesson's video and files, and each
 * episode's audio. A course or a podcast that cannot be read throws (both
 * reads are exact), so the hold says it could not be confirmed instead of
 * keeping only part of it; one whose record is not there has nothing to keep.
 */
import type { Product } from "@/lib/catalog";
import { picturesOf } from "@/lib/sales-page";
import { readPageExact } from "@/lib/sales-page-store";

type Hands = Pick<Product, "id" | "file" | "options" | "image" | "course" | "podcast">;
import { readCourseExact } from "@/lib/course";
import { readPodcast } from "@/lib/podcast";
import { imagePaths } from "@/lib/product-image";

export async function productFilePaths(product: Hands, statsId?: string): Promise<string[]> {
  const paths: string[] = [];
  if (product.file) paths.push(product.file.pathname);
  for (const option of product.options) if (option.file) paths.push(option.file.pathname);
  paths.push(...imagePaths(product.image));
  // The pictures on its own sales page, read exactly: a page that cannot be read throws.
  if (statsId) {
    const { page } = await readPageExact(statsId, product.id);
    for (const block of page?.blocks ?? []) for (const picture of picturesOf(block)) paths.push(picture.path);
  }
  if (product.course) {
    const course = await readCourseExact(product.course.id);
    for (const part of course?.modules ?? []) {
      for (const lesson of part.lessons) {
        if (lesson.video) paths.push(lesson.video.pathname);
        for (const file of lesson.files) paths.push(file.pathname);
      }
    }
  }
  if (product.podcast) {
    const podcast = await readPodcast(product.podcast.id);
    for (const episode of podcast?.episodes ?? []) paths.push(episode.pathname);
  }
  return [...new Set(paths.filter(Boolean))];
}
