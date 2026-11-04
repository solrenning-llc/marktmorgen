/**
 * A quiz's question bank (630 [HN6](7), unit 1; owner's Hotmart audit): the
 * creator may have each try draw only some of the questions, in a shuffled
 * order, and ask a student to wait a while between tries. Pure and
 * browser-safe; the page, the grading and the editor use it in unit 2.
 *
 * No new record: which questions a try shows is worked out from the course,
 * the lesson, the student and the number of the try, so the server draws the
 * very same set again when it grades, and a reload never changes the set. The
 * wait is counted from the last try, which the quiz already keeps.
 */

/** The longest wait a creator may ask between tries: one day. */
export const MAX_WAIT_MINUTES = 1_440;

/** A small, fixed pseudo-random sequence from a seed string (mulberry32 on an FNV-1a hash). */
function sequence(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed of one try: who, where, and which try. */
export function trySeed(courseId: string, lessonId: string, who: string, attempt: number): string {
  return `${courseId}:${lessonId}:${who}:${attempt}`;
}

/**
 * The questions one try shows, by their positions in the quiz: `draw` of them
 * (0 or anything not smaller than the total is all), in the quiz's order or,
 * with `shuffle`, in an order of their own. The same seed always gives the
 * same set in the same order.
 */
export function drawn(total: number, draw: number, shuffle: boolean, seed: string): number[] {
  const all = Array.from({ length: Math.max(0, total) }, (_, i) => i);
  const take = draw > 0 && draw < total ? draw : total;
  if (take === total && !shuffle) return all;
  const next = sequence(seed);
  // Fisher–Yates on the positions; the first `take` are the try's.
  for (let i = all.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const picked = all.slice(0, take);
  return shuffle ? picked : picked.sort((a, b) => a - b);
}

/** Seconds a student still waits before the next try; 0 when they may try now. */
export function waitLeft(waitMinutes: number, lastTryAt: number | null, now: number): number {
  if (!waitMinutes || lastTryAt === null) return 0;
  return Math.max(0, Math.ceil((lastTryAt + waitMinutes * 60_000 - now) / 1000));
}
