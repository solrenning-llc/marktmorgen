/**
 * Every file a product hands over, for the child-safety hold (unit 3b,
 * lib/held-files.ts): its own file, each price option's file, its picture
 * and the picture's smaller copy, each lesson's video and files, and each
 * episode's audio. A course or a podcast that cannot be read throws, so the
 * hold says it could not be confirmed instead of keeping only part of it.
 */
import type { Product } from "@/lib/catalog";
import { readCourseExact } from "@/lib/course";
import { readPodcast } from "@/lib/podcast";
import { imagePaths } from "@/lib/product-image";

export async function productFilePaths(product: Product): Promise<string[]> {
  const paths: string[] = [];
  if (product.file) paths.push(product.file.pathname);
  for (const option of product.options) if (option.file) paths.push(option.file.pathname);
  paths.push(...imagePaths(product.image));
  if (product.course) {
    const course = await readCourseExact(product.course.id);
    // A course the product names but nobody can find is unknown, never "nothing to keep".
    if (!course) throw new Error("the reported product's course could not be read");
    for (const module of course.modules) {
      for (const lesson of module.lessons) {
        if (lesson.video) paths.push(lesson.video.pathname);
        for (const file of lesson.files) paths.push(file.pathname);
      }
    }
  }
  if (product.podcast) {
    const podcast = await readPodcast(product.podcast.id);
    if (!podcast) throw new Error("the reported product's podcast could not be read");
    for (const episode of podcast.episodes) paths.push(episode.pathname);
  }
  return [...new Set(paths.filter(Boolean))];
}
