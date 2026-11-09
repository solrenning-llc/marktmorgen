/**
 * Every file a product hands over, for the child-safety hold (unit 3b,
 * lib/held-files.ts): its own file, each price option's file, its picture
 * and the picture's smaller copy, the pictures on its sales page, each
 * lesson's video and files, and each
 * episode's audio. A page, course or podcast that cannot be read (the reads are
 * exact) leaves the list incomplete: what is known is kept, and the hold says
 * the rest could not be confirmed; one whose record is not there has nothing.
 */
import type { Product } from "@/lib/catalog";
import { readCourseExact } from "@/lib/course";
import { readPodcast } from "@/lib/podcast";
import { imagePaths } from "@/lib/product-image";
import { picturesOf } from "@/lib/sales-page";
import { readPageExact } from "@/lib/sales-page-store";

type Hands = Pick<Product, "id" | "file" | "options" | "image" | "course" | "podcast">;

/**
 * The paths, and whether they are all of them. What the product record names
 * is always there; a page, course or podcast that cannot be read leaves the
 * list incomplete instead of empty, so what is known is still kept.
 */
export async function productFilePaths(product: Hands, statsId?: string): Promise<{ paths: string[]; complete: boolean }> {
  const paths: string[] = [];
  let complete = true;
  if (product.file) paths.push(product.file.pathname);
  for (const option of product.options) if (option.file) paths.push(option.file.pathname);
  paths.push(...imagePaths(product.image));
  // The pictures on its own sales page, read exactly.
  if (statsId) {
    try {
      const { page } = await readPageExact(statsId, product.id);
      for (const block of page?.blocks ?? []) for (const picture of picturesOf(block)) paths.push(picture.path);
    } catch {
      complete = false;
    }
  }
  if (product.course) {
    try {
      const course = await readCourseExact(product.course.id);
      for (const part of course?.modules ?? []) {
        for (const lesson of part.lessons) {
          if (lesson.video) paths.push(lesson.video.pathname);
          for (const file of lesson.files) paths.push(file.pathname);
        }
      }
    } catch {
      complete = false;
    }
  }
  if (product.podcast) {
    try {
      const podcast = await readPodcast(product.podcast.id);
      for (const episode of podcast?.episodes ?? []) paths.push(episode.pathname);
    } catch {
      complete = false;
    }
  }
  return { paths: [...new Set(paths.filter(Boolean))], complete };
}
