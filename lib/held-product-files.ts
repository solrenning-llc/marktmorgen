/**
 * Every file a product hands over, for the child-safety hold (unit 3b,
 * lib/held-files.ts): its own file, each price option's file, its picture
 * and the picture's smaller copy, each lesson's video and files, and each
 * episode's audio. A course or a podcast that cannot be read throws (both
 * reads are exact), so the hold says it could not be confirmed instead of
 * keeping only part of it; one whose record is not there has nothing to keep.
 */
import type { Product } from "@/lib/catalog";

type Hands = Pick<Product, "file" | "options" | "image" | "course" | "podcast">;
import { readCourseExact } from "@/lib/course";
import { readPodcast } from "@/lib/podcast";
import { imagePaths } from "@/lib/product-image";

export async function productFilePaths(product: Hands): Promise<string[]> {
  const paths: string[] = [];
  if (product.file) paths.push(product.file.pathname);
  for (const option of product.options) if (option.file) paths.push(option.file.pathname);
  paths.push(...imagePaths(product.image));
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
