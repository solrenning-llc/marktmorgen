/** Server page decides availability. This native form also works without scripts. */
export function DiscordSignIn({handle}: {handle: string}) {
  return <form method="post" action="/api/auth/discord" className="mt-6 border-t border-line pt-6">
    {handle ? <input type="hidden" name="handle" value={handle}/> : null}
    <button type="submit" className="btn btn-secondary btn-block">Continue with Discord</button>
    <p className="mt-2 text-center text-sm text-ink-soft">Use the email address Discord has verified for your account. We do not connect your servers or messages.</p>
  </form>;
}
