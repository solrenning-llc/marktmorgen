/**
 * Whether buyers' files for review (750 [CD1]) are on.
 *
 * Off until the buyer's side of the lesson page and the notices to the
 * buyer work: until then nothing is shown about it in the studio, no lesson
 * can be set to ask for one, and the buyer's upload door answers "off". It is
 * turned on only in the pull request that also makes the trainers' page
 * (lib/feature-pages.ts) say "Yes" (rule VR: nothing is shown that does not
 * work). tests/submission-studio.test.ts holds it off.
 */
export const SUBMISSIONS_READY = false;
