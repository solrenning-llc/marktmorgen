/**
 * What a session let in without its second step may not do until two-step
 * login turns off (lib/two-step.ts LOCKED_NEEDS and LOCKED_ACTIONS), said
 * the same way everywhere it is said: the code page, the lost-inbox page,
 * the studio, the emails, the help center and the security page. One list,
 * so no page promises more or less than the code holds back
 * (tests/locked-deletes.test.ts).
 */
export const LOCKED_LIST =
  "payments, your plan, your team, exports, imports, settings, sending email to your list or your members, deleting anything for good (people, products, lessons, files, forms, posts), your sign-in address, passkeys and two-step login";

/** The sentence a refused request answers with, for the studio to show. */
export const LOCKED_MESSAGE =
  "You got in without your second step, so this waits until two-step login turns off. To do it now, log in with your app's code or a passkey.";

/** The same list at the start of a sentence. */
export const LOCKED_LIST_START = LOCKED_LIST.charAt(0).toUpperCase() + LOCKED_LIST.slice(1);
