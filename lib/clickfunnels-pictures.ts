/**
 * 394 [CX5], unit 1: a saved page's pictures, by the path the browser's
 * "complete" save gave each in the page's own folder ("Sales Page_files/
 * hero.jpg"), and those paths matched to the files the creator chooses
 * from that folder. Nothing is fetched: a picture that is only an address on
 * ClickFunnels' servers (or anyone's) has no local path and stays one the
 * creator uploads by hand. Browser-safe and pure.
 */

/** Pictures kept from one saved page, at most; a page's own blocks hold far fewer. */
export const MAX_SAVED_PICTURES = 30;

export type SavedPicture = { ref: string | null; alt: string };

const PICTURE = /\.(?:png|jpe?g|gif|webp|avif)$/i;
// No control characters, hidden direction marks or backslashes in a path.
const ODD = /[\\\u0000-\u001f\u007f؜​-‏‪-‮⁠-⁯﻿]/;

/**
 * The picture's path inside the saved page's folder, or null when it is not
 * one: an address (any scheme, or starting with "/"), a path leaving the
 * folder or without one, or a file that is not a picture this platform
 * shows (SVG can carry scripts, so it is not one).
 */
export function savedPictureRef(src: string): string | null {
  const raw = src.trim();
  if (!raw || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.includes("\\")) return null;
  let path = raw.split(/[?#]/)[0].replace(/^(?:\.\/)+/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (ODD.test(path) || path.length > 300) return null;
  const parts = path.split("/");
  if (parts.length < 2 || parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return PICTURE.test(path) ? path : null;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Each distinct picture path matched to one chosen file: by the file's own
 * path in the folder chosen (`path`, as the browser gives a folder's files),
 * or else by its name, only when that name belongs to one picture and one
 * file. Anything else is missing, never guessed.
 */
export function matchSavedPictures(refs: (string | null)[], files: { name: string; path: string }[]): { matched: { ref: string; file: number }[]; missing: string[] } {
  const wanted = [...new Set(refs.filter((ref): ref is string => ref !== null))];
  const byPath = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  files.forEach((file, i) => {
    if (file.path) byPath.set(file.path, [...(byPath.get(file.path) ?? []), i]);
    byName.set(file.name, [...(byName.get(file.name) ?? []), i]);
  });
  const namesWanted = new Map<string, number>();
  for (const ref of wanted) namesWanted.set(nameOf(ref), (namesWanted.get(nameOf(ref)) ?? 0) + 1);
  const matched: { ref: string; file: number }[] = [];
  const missing: string[] = [];
  for (const ref of wanted) {
    const exact = byPath.get(ref);
    const named = byName.get(nameOf(ref));
    if (exact?.length === 1) matched.push({ ref, file: exact[0] });
    else if (!exact && named?.length === 1 && namesWanted.get(nameOf(ref)) === 1 && !files[named[0]].path) matched.push({ ref, file: named[0] });
    else missing.push(ref);
  }
  return { matched, missing };
}
