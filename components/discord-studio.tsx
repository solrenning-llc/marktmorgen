"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { type DiscordRole, roleColor } from "@/lib/discord-rules";

type Product = { id: string; title: string; roles: string[] };
type Person = { id: string; name: string; email: string; roles: number; at: number };

const ERRORS: Record<string, string> = {
  role_out_of_reach: "The bot cannot give one of those roles: in your server's settings, move the Marktmorgen role above it, then reload this page.",
  too_many: "Up to 20 products can give roles. Take a product off before adding another.",
  server: "Discord could not be reached just now. Nothing was changed; try again in a moment.",
  not_connected: "No server is connected any more. Reload the page.",
  name: "Type a name for the role.",
  signed_out: "Your session ended. Log in again.",
};

const errorText = (code: string | undefined) => ERRORS[code ?? ""] ?? "Something went wrong on our side. Nothing was changed; try again in a moment.";

async function send(payload: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; roles?: string[]; role?: DiscordRole; people?: number }> {
  try {
    const response = await fetch("/api/store/discord", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  } catch {
    return { ok: false, error: "server_error" };
  }
}

function day(seconds: number): string {
  return seconds ? new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}

/** One product: the roles it gives, up to the limit. */
function ProductRoles({ product, roles, names, max }: { product: Product; roles: DiscordRole[]; names: Map<string, string>; max: number }) {
  const [saved, setSaved] = useState(product.roles);
  const [chosen, setChosen] = useState(product.roles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = chosen.join() !== saved.join();
  const groupId = `discord-${product.id}`;
  // A role chosen before that the bot can no longer give is still shown, so it can be taken off.
  const shown = [...roles, ...saved.filter((id) => !roles.some((r) => r.id === id)).map((id) => ({ id, name: names.get(id) ?? "A role the bot cannot give", color: 0, position: 0, managed: false }))];
  return (
    <li className="rounded-[var(--r-sm)] border border-line bg-white p-4">
      <fieldset>
        <legend className="font-semibold text-ink">{product.title}</legend>
        <p id={`${groupId}-hint`} className="mt-1 text-sm text-ink-soft">
          {saved.length ? `Gives ${saved.length} ${saved.length === 1 ? "role" : "roles"}.` : "Gives no role: buying it does not open the server."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {shown.map((role) => {
            const on = chosen.includes(role.id);
            const full = !on && chosen.length >= max;
            const color = roleColor(role.color);
            return (
              <label key={role.id} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm ${on ? "border-violet-brand bg-lilac text-ink" : "border-line text-ink-soft"} ${full ? "opacity-50" : ""}`}>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-violet-brand"
                  checked={on}
                  disabled={full || busy}
                  aria-describedby={`${groupId}-hint`}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, role.id] : chosen.filter((id) => id !== role.id))}
                />
                {color ? <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: color }} /> : null}
                <span>{role.name}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
      {changed ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            aria-busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const answer = await send({ action: "roles", productId: product.id, roles: chosen });
              setBusy(false);
              if (!answer.ok) return setError(errorText(answer.error));
              setSaved(answer.roles ?? chosen);
              toast(chosen.length ? "Saved. New buyers get these roles; people already in are updated at the next check." : "Saved. This product no longer opens the server.");
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setChosen(saved); setError(null); }}>
            Cancel
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** The studio's Discord page: connecting a server, the roles each product gives, and who is in. */
export function DiscordStudio({
  connectAction,
  server,
  roles: startRoles,
  allRoles,
  products,
  members,
  limits,
}: {
  connectAction: string;
  server: { name: string; kick: boolean; reachable: boolean } | null;
  roles: DiscordRole[];
  allRoles: { id: string; name: string }[];
  products: Product[];
  members: Person[];
  limits: { roles: number; products: number; hours: number };
}) {
  const router = useRouter();
  const [roles, setRoles] = useState(startRoles);
  const [newRole, setNewRole] = useState("");
  const [making, setMaking] = useState(false);
  const [kick, setKick] = useState(server?.kick ?? false);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = new Map(allRoles.map((r) => [r.id, r.name]));

  const connect = (label: string) => (
    <form action={connectAction} method="post" className="mt-4">
      <button type="submit" className="btn btn-primary">{label}</button>
    </form>
  );

  if (!server) {
    return (
      <section className="card mt-8 p-6 sm:p-8" aria-labelledby="discord-connect">
        <h2 id="discord-connect" className="text-lg font-semibold tracking-[-0.02em] text-ink">Connect your server</h2>
        <ol className="mt-3 max-w-2xl list-decimal space-y-2 pl-5 text-ink-soft">
          <li>Press the button. Discord opens and asks which of your servers to add Marktmorgen&rsquo;s bot to; you need to be allowed to manage that server.</li>
          <li>The bot asks to put people in the server, to give and take back roles, and to remove people, which it does only if you ask it to. It never reads or sends messages.</li>
          <li>Back here, choose which products give which roles. Set your paid channels to be seen only by those roles in Discord.</li>
        </ol>
        {connect("Connect a Discord server")}
      </section>
    );
  }

  return (
    <>
      <section className="card mt-8 p-6 sm:p-8" aria-labelledby="discord-server">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="discord-server" className="text-lg font-semibold tracking-[-0.02em] text-ink">{server.name || "Your server"}</h2>
          <span className={`tag ${server.reachable ? "tag-live" : "tag-next"}`}>{server.reachable ? "Connected" : "Cannot be reached"}</span>
        </div>
        {server.reachable ? (
          <p className="mt-2 max-w-2xl text-ink-soft">
            The bot can give the roles below its own. To give a higher one, open your server&rsquo;s settings, then Roles, and drag the Marktmorgen role above it.
          </p>
        ) : (
          <>
            <p className="notice notice-error mt-3" role="alert">
              The bot could not read the server: it may have been removed from it. Connect it again; the roles each product gives are kept.
            </p>
            {connect("Connect it again")}
          </>
        )}

        <label className="mt-5 flex min-h-11 cursor-pointer items-start gap-3 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand"
            checked={kick}
            disabled={busy}
            onChange={async (e) => {
              const on = e.target.checked;
              setBusy(true);
              const answer = await send({ action: "kick", on });
              setBusy(false);
              if (!answer.ok) return setError(errorText(answer.error));
              setKick(on);
              toast(on ? "People whose access ends will be removed from the server." : "People whose access ends will stay in the server, without the roles.");
            }}
          />
          <span>
            <span className="font-semibold">Remove people from the server when their access ends.</span> Without this, they only lose the roles their
            purchase gave, and stay in your server&rsquo;s public channels.
          </span>
        </label>
        {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
      </section>

      {server.reachable ? (
        <section className="card mt-8 p-6 sm:p-8" aria-labelledby="discord-products">
          <h2 id="discord-products" className="text-lg font-semibold tracking-[-0.02em] text-ink">Which products give which roles</h2>
          <p className="mt-2 max-w-2xl text-ink-soft">{`Up to ${limits.roles} roles for each product, on up to ${limits.products} products. A product in a bundle gives its roles to the bundle's buyers too.`}</p>
          {products.length === 0 ? (
            <p className="mt-5 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">Add a product first.</p>
          ) : roles.length === 0 && products.every((p) => !p.roles.length) ? (
            <p className="mt-5 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">The bot cannot give any role of your server yet. Make one below, or move the Marktmorgen role above the ones you want it to give.</p>
          ) : (
            <ul className="mt-5 space-y-3">
              {products.map((product) => (
                <ProductRoles key={product.id} product={product} roles={roles} names={names} max={limits.roles} />
              ))}
            </ul>
          )}
          <form
            className="mt-6 flex flex-wrap items-end gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!newRole.trim()) return setError(ERRORS.name);
              setMaking(true);
              setError(null);
              const answer = await send({ action: "role", name: newRole });
              setMaking(false);
              if (!answer.ok || !answer.role) return setError(errorText(answer.error));
              setRoles([answer.role, ...roles]);
              setNewRole("");
              toast(`The role ${answer.role.name} was made in your server. Choose it for a product above.`);
            }}
          >
            <label className="block min-w-[14rem] flex-1">
              <span className="field-label">Make a new role in your server</span>
              <input className="field mt-2" maxLength={100} value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder="For example: Members" />
            </label>
            <button type="submit" className="btn btn-secondary" disabled={making} aria-busy={making}>{making ? "Making…" : "Make the role"}</button>
          </form>
        </section>
      ) : null}

      <section className="card mt-8 p-6 sm:p-8" aria-labelledby="discord-people">
        <h2 id="discord-people" className="text-lg font-semibold tracking-[-0.02em] text-ink">{`Who joined · ${members.length}`}</h2>
        <p className="mt-2 max-w-2xl text-ink-soft">{`Everyone given roles by a purchase, checked again about every ${limits.hours} hours. Somebody whose access ended is taken off this list once their roles are taken back.`}</p>
        {members.length === 0 ? (
          <p className="mt-5 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">Nobody has joined yet. Buyers see “Join the Discord” after paying, and on their orders.</p>
        ) : (
          <div className="mt-5 overflow-x-auto" tabIndex={0} role="region" aria-label="People who joined, one row each">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-ink-mute">
                  <th scope="col" className="py-2 pr-3 font-semibold">On Discord</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Bought with</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Roles</th>
                  <th scope="col" className="py-2 font-semibold">Joined</th>
                </tr>
              </thead>
              <tbody>
                {members.map((person) => (
                  <tr key={person.id} className="border-t border-line align-top">
                    <td className="max-w-[12rem] break-words py-2 pr-3 font-semibold text-ink">{person.name || person.id}</td>
                    <td className="max-w-[14rem] break-all py-2 pr-3">{person.email}</td>
                    <td className="py-2 pr-3 tabular-nums">{person.roles}</td>
                    <td className="whitespace-nowrap py-2">{day(person.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8 border-t border-line pt-6">
        {leaving ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-ink-soft">Disconnect the server? The bot leaves it. Roles already given stay as they are, and nobody new can join from your store.</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const answer = await send({ action: "disconnect" });
                setBusy(false);
                if (!answer.ok) return setError(errorText(answer.error));
                toast("Disconnected.");
                router.refresh();
              }}
            >
              Yes, disconnect
            </button>
            <button type="button" className="text-sm font-bold text-ink-soft underline underline-offset-4" onClick={() => setLeaving(false)}>Keep it</button>
          </div>
        ) : (
          <button type="button" className="text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger" onClick={() => setLeaving(true)}>
            Disconnect the server
          </button>
        )}
      </section>
    </>
  );
}
