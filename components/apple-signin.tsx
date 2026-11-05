/** Visibility is decided by the server page; the native form needs no client script. */
export function AppleSignIn({handle}: {handle:string}) {
  return <form method="post" action="/api/auth/apple" className="mt-6 border-t border-line pt-6">
    {handle ? <input type="hidden" name="handle" value={handle}/> : null}
    <button type="submit" className="btn btn-secondary btn-block">Continue with Apple</button>
    <p className="mt-2 text-center text-sm text-ink-soft">If you hide your email, your account here uses Apple&apos;s private relay address. It may be a different account from one you opened with your usual email. To open that account, use its emailed link.</p>
  </form>;
}
