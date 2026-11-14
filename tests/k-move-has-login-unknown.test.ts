/**
 * app/api/auth/move: once the move link is spent, the route asks whether the new
 * address holds ways in of its own (lib/second-step-gate.ts holdsSecondStep). When
 * that question cannot be answered (a Redis reply that fails), the move is refused,
 * which is right, but the person was told "That address has its own passkeys or
 * two-step login ... Remove them from that address first": a definite answer drawn
 * from a read that failed (CX-123 rule 24). It must say the move could not be
 * finished just now (move-unread), with nothing moved.
 * Audit of the API routes, Claude 3 (cloud K), 11 November 2026.
 *
 * Synthetic only: the Redis stand-in, a fetch stub for the email provider.
 */
import { NextRequest } from "next/server";
import { openSession, sendMoveLink } from "@/lib/auth";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { claimHandle, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const ORIGIN = "https://marktmorgen.com";
const form = (fields: Record<string, string>) =>
  new NextRequest(`${ORIGIN}/api/auth/move`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

async function linkFor(from: string, to: string): Promise<string> {
  await claimHandle(from, from.split("@")[0], "K", "");
  const asker = await openSession(from);
  mails.length = 0;
  await sendMoveLink(from, to, ORIGIN, asker);
  return /confirm-move\?token=([0-9a-f]{64})/.exec(mails.find((m) => m.to === to)?.text ?? "")?.[1] ?? "";
}

async function main(): Promise<void> {
  redis.clear();
  const quiet = console.error;
  console.error = () => {};

  part("The new address's passkeys cannot be read: never told it has its own");
  const token = await linkFor("k-mv-from@example.com", "k-mv-to@example.com");
  is("(a move link was sent)", token.length, 64);
  redis.pipeline = async (commands: Command[]) => {
    if (commands.some((c) => String(c[1] ?? "").startsWith("nl:pk:"))) throw new Error("Upstash answered 503");
    return real(commands);
  };
  const where = (await moveRoute(form({ token }))).headers.get("location") ?? "";
  redis.pipeline = real;
  is("said as a move that could not be finished just now", where, `${ORIGIN}/signin?status=move-unread`);
  is("never as an address with its own passkeys or two-step login", where.endsWith("move-has-login"), false);
  is("nothing moved: the store stays at the old address", [Boolean(await storeForEmail("k-mv-from@example.com")), Boolean(await storeForEmail("k-mv-to@example.com"))], [true, false]);

  part("Control: a new address that really holds a way in is still told so");
  const token2 = await linkFor("k-mv-from2@example.com", "k-mv-to2@example.com");
  // A move already marked on the new address counts as a way in of its own (lib/second-step-gate.ts holdsSecondStep).
  redis.pipeline = async (commands: Command[]) =>
    (await real(commands)).map((reply, i) => (commands[i][0] === "EXISTS" && commands.length === 2 ? 1 : reply));
  const where2 = (await moveRoute(form({ token: token2 }))).headers.get("location") ?? "";
  redis.pipeline = real;
  is("refused as move-has-login", where2, `${ORIGIN}/signin?status=move-has-login`);
  console.error = quiet;
  done();
}

void main();
