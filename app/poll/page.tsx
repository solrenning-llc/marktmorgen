import type { Metadata } from "next";
import { PollView } from "@/components/email-poll-view";
import { pollPage } from "@/lib/email-poll-vote";

/**
 * The page a poll link in a store's email opens (125 [F2-EMAIL-POLLS],
 * unit 5). Opening it counts nothing (mail scanners open every link): the
 * answer is counted only by the press of Confirm, a POST to
 * app/api/mail/poll/route.ts, which comes back here with what happened.
 * Drawn by components/email-poll-view.tsx in the store's language.
 */
type Query = { [key: string]: string | string[] | undefined };

const param = (query: Query, key: string, most: number) => {
  const value = query[key];
  return typeof value === "string" ? value.slice(0, most) : "";
};

/** The time a page is drawn at, kept out of the render itself. */
const drawnAt = () => Date.now();

export const metadata: Metadata = {
  title: "Answer a poll — Marktmorgen",
  robots: { index: false, follow: false },
};

export default async function PollPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const broadcastId = param(query, "b", 32);
  const link = param(query, "k", 48);
  const page = await pollPage({ broadcastId, link, now: drawnAt() });
  return <PollView page={page} broadcastId={broadcastId} link={link} asked={param(query, "a", 1)} done={param(query, "done", 12)} />;
}
