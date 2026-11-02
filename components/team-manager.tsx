"use client";

import { useState } from "react";
import { EmailInput } from "@/components/email-input";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";
import { type Permission, type TeamRole, ROLE_NAMES, ROLE_SUMMARIES, TEAM_ROLES, can } from "@/lib/team-roles";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

export type TeamRow = { email: string; role: TeamRole; joinedAt: string };
export type InviteRow = { id: string; email: string; role: TeamRole; expiresAt: number };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  shape: "That does not look like an email address.",
  role: "Choose a role.",
  owner: "That is the address that owns this store.",
  member: "That person is already on the team.",
  invited: "That address already has an invitation waiting. Take it back first to send a new one.",
  full: "A store's team holds five people, invitations waiting included.",
  limited: "That is a lot of invitations for one day. Try again tomorrow.",
  unsent: "The invitation email could not be sent just now, so nothing was kept. Try again in a moment.",
  unknown: "That is not there anymore. Reload the page.",
  same: "They already have that role.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Answer = { ok?: boolean; error?: string };

async function call(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/store/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

function day(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The owner's view of a store's team: who is on it and in what role, who is
 * invited, and a form to invite someone. Every change is made on the server
 * (app/api/store/team) and the page is read again after it.
 */
export function TeamManager({
  owner,
  members,
  invites,
  max,
}: {
  owner: string;
  members: TeamRow[];
  invites: InviteRow[];
  max: number;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("editor");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const used = members.length + invites.length;

  async function run(key: string, payload: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(key);
    setError(null);
    const answer = await call(payload);
    setBusy(null);
    if (!answer.ok) {
      setError(MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error);
      return false;
    }
    toast(done);
    router.refresh();
    return true;
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section className="card min-w-0 p-6 sm:p-8" aria-labelledby="people-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="people-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            People on this store
          </h2>
          <span className="text-sm tabular-nums text-ink-soft">{`${used} of ${max} places used`}</span>
        </div>
        <ul className="mt-4 divide-y divide-line">
          <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
            <span className="min-w-0">
              <span className="block break-all font-semibold text-ink">{owner}</span>
              <span className="block text-xs text-ink-soft">You. Everything, including the plan, payments and the team.</span>
            </span>
            <span className="tag">Owner</span>
          </li>
          {members.map((m) => (
            <li key={m.email} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
              <span className="min-w-0">
                <span className="block break-all font-semibold text-ink">{m.email}</span>
                <span className="block text-xs text-ink-soft">{`Joined ${day(m.joinedAt)}`}</span>
              </span>
              <span className="flex flex-wrap items-center gap-3">
                <label className="sr-only" htmlFor={`role-${m.email}`}>{`Role for ${m.email}`}</label>
                <select
                  id={`role-${m.email}`}
                  className="field w-auto py-2 text-sm"
                  value={m.role}
                  disabled={busy !== null}
                  onChange={(event) =>
                    void run(`role-${m.email}`, { action: "role", email: m.email, role: event.target.value }, `${m.email} is now ${ROLE_NAMES[event.target.value as TeamRole]}.`)
                  }
                >
                  {TEAM_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_NAMES[r]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busy !== null}
                  aria-busy={busy === `remove-${m.email}`}
                  className="inline-flex min-h-11 -my-2.5 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
                  onClick={() => {
                    if (window.confirm(`Take ${m.email} off the team? It counts from their next click.`)) {
                      void run(`remove-${m.email}`, { action: "remove", email: m.email }, `${m.email} is off the team.`);
                    }
                  }}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
          {invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
              <span className="min-w-0">
                <span className="block break-all font-semibold text-ink-soft">{i.email}</span>
                <span className="block text-xs text-ink-soft">
                  {`Invited as ${ROLE_NAMES[i.role]} · the link works until ${new Date(i.expiresAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <span className="tag tag-next">Waiting</span>
                <button
                  type="button"
                  disabled={busy !== null}
                  aria-busy={busy === `revoke-${i.id}`}
                  className="inline-flex min-h-11 -my-2.5 items-center text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger"
                  onClick={() => void run(`revoke-${i.id}`, { action: "revoke", id: i.id }, "Invitation taken back.")}
                >
                  Take back
                </button>
              </span>
            </li>
          ))}
        </ul>
        {members.length === 0 && invites.length === 0 ? (
          <p className="mt-2 rounded-[12px] bg-paper px-4 py-3 text-sm text-ink-soft ring-1 ring-line">
            Nobody else yet. Invite a person below and choose what they can do.
          </p>
        ) : null}

        {used < max ? (
          <form
            className="mt-6 border-t border-line pt-6"
            onSubmit={async (event) => {
              event.preventDefault();
              const ok = await run("invite", { action: "invite", email, role }, `Invitation sent to ${email.trim()}.`);
              if (ok) setEmail("");
            }}
          >
            <h3 className="font-semibold text-ink">Invite someone</h3>
            <label htmlFor="invite-email" className="field-label mt-4 block">
              Their email
            </label>
            <EmailInput
              id="invite-email"
              required
              autoComplete="off"
              className="field mt-2"
              placeholder="name@example.com"
              value={email}
              onChange={setEmail}
            />
            <fieldset className="mt-5">
              <legend className="field-label">What they can do</legend>
              <div className="mt-2 space-y-2">
                {TEAM_ROLES.map((r) => (
                  <label
                    key={r}
                    className={`flex cursor-pointer gap-3 rounded-[12px] p-3 ring-1 transition-colors motion-reduce:transition-none ${
                      role === r ? "bg-lilac ring-violet-brand/40" : "ring-line hover:bg-paper"
                    }`}
                  >
                    <input type="radio" name="invite-role" value={r} checked={role === r} onChange={() => setRole(r)} className="mt-1" />
                    <span>
                      <span className="block font-semibold text-ink">{ROLE_NAMES[r]}</span>
                      <span className="block text-sm text-ink-soft">{ROLE_SUMMARIES[r]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" className="btn btn-primary mt-5" disabled={busy !== null || !email.trim()} aria-busy={busy === "invite"}>
              <Icon name="mail" size={16} />
              Send the invitation
            </button>
            <p className="mt-3 text-sm text-ink-soft">
              They get a link that works once, for 7 days. There is no password: they log in with their own email, or a
              passkey. You get an email when they join and whenever a role changes.
            </p>
          </form>
        ) : (
          <p className="mt-6 notice notice-info">{`The team is full: ${max} people, invitations waiting included. Remove someone or take an invitation back to make room.`}</p>
        )}
        {error ? (
          <p className="notice notice-error mt-4" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      <RoleTable />
    </div>
  );
}

/** The rows of the table, each one permission; who has it is read from lib/team-roles.ts. */
const ROWS: { what: string; permission: Permission }[] = [
  { what: "Products, prices, files, courses, calls, offers and sales pages", permission: "products" },
  { what: "The store page: name, description, look, links", permission: "page" },
  { what: "Numbers: visits, sales totals, sources", permission: "stats" },
  { what: "Orders and bookings, and sending a purchase email again", permission: "orders" },
  { what: "Moderate the community, see who RSVP'd to its live events", permission: "community" },
  { what: "Schedule, move and cancel live events, post replays", permission: "events" },
  { what: "Hide, show and answer reviews", permission: "reviews" },
  { what: "Write and keep email drafts", permission: "draft" },
  { what: "Send email to your list, run sequences, import addresses into the list", permission: "send" },
  { what: "Import products, lists and past buyers from another platform", permission: "import" },
  { what: "Address, domain, currency, pixels, tax, webhooks, discounts, affiliates, checkout reminders, review emails, video calls, calendars, email platforms", permission: "settings" },
  { what: "Download files of buyers' and affiliates' addresses", permission: "export" },
];

/** What each role can do, as a table, beside the team. */
function RoleTable() {
  return (
    <section className="card min-w-0 p-6 sm:p-8" aria-labelledby="roles-title">
      <h2 id="roles-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
        What each role can do
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        Only you pay for the store, connect its Stripe account, manage the team and delete the store. Checked by the
        server on every click, not only hidden on the screen.
      </p>
      <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label="What each role can do">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-ink-mute">
              <th scope="col" className="py-2 pr-3 font-semibold">
                <span className="sr-only">What</span>
              </th>
              {TEAM_ROLES.map((r) => (
                <th key={r} scope="col" className="px-1 py-2 text-center font-semibold">
                  {ROLE_NAMES[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.what} className="border-t border-line align-top">
                <th scope="row" className="py-2 pr-3 font-normal text-ink">
                  {row.what}
                </th>
                {TEAM_ROLES.map((r) => (
                  <td key={r} className="px-1 py-2 text-center">
                    {can(r, row.permission) ? (
                      <>
                        <Icon name="check" size={16} className="mx-auto text-mint-deep" />
                        <span className="sr-only">Yes</span>
                      </>
                    ) : (
                      <>
                        <span className="text-ink-mute" aria-hidden="true">
                          —
                        </span>
                        <span className="sr-only">No</span>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** "Leave this store", for someone on its team, at the bottom of their studio. */
export function LeaveTeam({ store }: { store: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        className="btn btn-ghost"
        onClick={async () => {
          if (!window.confirm(`Leave ${store}? You will need a new invitation to come back.`)) return;
          setBusy(true);
          setError(null);
          const answer = await call({ action: "leave" });
          setBusy(false);
          if (answer.ok) {
            router.push("/studio?team=left");
            router.refresh();
            return;
          }
          setError(MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error);
        }}
      >
        Leave this store
      </button>
      {error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
