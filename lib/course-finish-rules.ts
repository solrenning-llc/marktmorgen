/**
 * How long a course's start and finish marks are kept (lib/course-finish.ts): 400 days. On its own, with no import,
 * so lib/removed-courses.ts can read it without depending on the course modules that depend on it.
 */
export const FINISH_KEEP_SECONDS = 400 * 86_400;
