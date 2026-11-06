/**
 * "Continue with Google", under the email form on /signin (lib/google-signin.ts).
 * A plain form, so it works without the page's scripts. Shown only while
 * it is switched on; the emailed link above always works without it.
 */
export function GoogleSignIn({ handle }: { handle: string }) {
  return (
    <form method="post" action="/api/auth/google" className="mt-6 border-t border-line pt-6">
      {handle ? <input type="hidden" name="handle" value={handle} /> : null}
      <button type="submit" className="btn btn-secondary btn-block">
        Continue with Google
      </button>
      <p className="mt-2 text-center text-sm text-ink-soft">
        Google only tells us your email address. It works for a Gmail address, or a work address on Google Workspace.
      </p>
    </form>
  );
}
