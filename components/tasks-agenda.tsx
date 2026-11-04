"use client";

import Link from "next/link";
import { useCreatorDay } from "@/components/person-tasks";
import type { AgendaDayGroup } from "@/lib/person-agenda";
import type { DueTask } from "@/lib/person-tasks";

/** A calendar date as words, read as the date it is, never moved through a time zone. */
function dayWords(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/** A task in the agenda, with the address and page of the person it is about when found. */
export type AgendaListRow = DueTask & { email: string | null; href: string };

/**
 * The tasks agenda's groups (639 [GL7](6), unit 3; lib/person-agenda.ts),
 * for the creator's own day: the server sends the groups for each day it may
 * be (agendaForDays) and draws them for its own; the browser then shows the
 * ones for its day (useCreatorDay).
 */
export function TasksAgendaList({ rows, days, serverDay, found }: { rows: AgendaListRow[]; days: Record<string, AgendaDayGroup[]>; serverDay: string; /** Whether the buyers were read from Stripe, and whether that reading was cut short; null when it failed. */ found: { partial: boolean } | null }) {
  const creatorDay = useCreatorDay(serverDay);
  const today = days[creatorDay] ? creatorDay : serverDay;
  const groups = days[today] ?? [];
  return (
    <>
      {groups.map((group) => (
        <div key={group.key} className="mt-6">
          <h3 className="text-base font-semibold text-ink">{`${group.title} (${group.rows.length + group.more})`}</h3>
          <ul className="mt-2 divide-y divide-line">
            {group.rows.map((place) => {
              const row = rows[place];
              if (!row) return null;
              return (
                <li key={`${row.person}:${row.task.id}`} className="py-3 text-sm">
                  <p className="text-ink [overflow-wrap:anywhere]">{row.task.text}</p>
                  <p className="mt-1 text-xs text-ink-soft">
                    {row.task.due ? (row.task.due < today ? `Was due ${dayWords(row.task.due)}` : `Due ${dayWords(row.task.due)}`) : "No date"}
                    {row.task.assignee ? ` · ${row.task.assignee}` : " · Nobody named"}
                  </p>
                  {row.email && row.href ? (
                    <Link href={row.href} className="mt-1 inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4 [overflow-wrap:anywhere]">
                      {row.email}
                    </Link>
                  ) : found ? (
                    <p className="mt-1 text-xs text-ink-soft">{`About someone not among the buyers read from your Stripe account${found.partial ? " (the oldest are not read)" : ""}: find them by their address above.`}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {group.more ? <p className="mt-2 text-sm text-ink-soft">{`And ${group.more} more ${group.more === 1 ? "task" : "tasks"} in this group, shown as the first ones are done.`}</p> : null}
        </div>
      ))}
    </>
  );
}
