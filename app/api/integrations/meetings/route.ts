import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { isMeetProvider } from "@/lib/call-setup";
import { ACCOUNT_NAMES, NotConnected, disconnectFor, logProblem, meetView } from "@/lib/meet-connect";
import { ProviderError, isConfigured } from "@/lib/meet-providers";
import { makeTest, moveTest, removeTest, TestMeetingUnavailable } from "@/lib/meet-test";
import { guardStoreWrite } from "@/lib/store-request";
import { MEETING_TEST_PAUSED_WORDS, integrationPauseWord } from "@/lib/integration-pause";

/** Changes a store may make here in a minute: each one reaches Google or Zoom. */
const PER_MINUTE = 20;

/** Making a meeting at the provider can take seconds, and a token may be renewed first. */
export const maxDuration = 30;

/**
 * The store's Google Calendar or Zoom connection, `{ action, provider }`:
 *
 *   disconnect   the access is given back to the provider, the tokens are
 *                deleted, and the owner is told by email (lib/meet-connect.ts);
 *                `providerAccessRemoved: false` when the provider did not confirm it
 *   test         makes one test meeting on the connected account, or gives
 *                back the one already there (lib/meet-test.ts)
 *   movetest     moves that test meeting an hour later, as a buyer's move does
 *   untest       deletes that test meeting on the account, and forgets it
 *
 * Only the owner and Admins ("settings", lib/team-roles.ts).
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 2_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const provider = body.provider;
  const action = body.action;
  // A deployment may have removed its OAuth credentials while old tokens remain.
  // Forgetting an existing connection must still reach the bounded cleanup below.
  // Creating or testing meetings continues to require the configured provider.
  if ((action !== "disconnect" && action !== "test" && action !== "movetest" && action !== "untest") || !isMeetProvider(provider) || (action !== "disconnect" && !isConfigured(provider))) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (!store.statsId) {
    return action === "disconnect"
      ? Response.json({ ok: true, view: await meetView(null, store) })
      : Response.json({ ok: false, error: "not_connected" }, { status: 400 });
  }
  // 232 [CA1] 4b4a: a test meeting made or moved at the provider waits while the plan's costs
  // are paused; deleting one (untest) and disconnecting stay open.
  const paused = action === "test" || action === "movetest" ? integrationPauseWord(store) : null;
  if (paused) return Response.json({ ok: false, error: paused, message: MEETING_TEST_PAUSED_WORDS[paused] }, { status: 409 });
  const refused = await withinServiceWhy("meet-manage", store.statsId, PER_MINUTE, 60, store);
  if (refused) return serviceRefusedJson(refused, "limited");
  if (action === "test" || action === "movetest" || action === "untest") {
    try {
      if (action === "test") return Response.json({ ok: true, test: await makeTest(store, provider) });
      if (action === "movetest") {
        const moved = await moveTest(store, provider);
        return moved ? Response.json({ ok: true, test: moved }) : Response.json({ ok: false, error: "no_test" }, { status: 400 });
      }
      await removeTest(store.statsId, provider);
      return Response.json({ ok: true, test: null });
    } catch (error) {
      if (error instanceof TestMeetingUnavailable) return Response.json({ ok: false, error: "unavailable", message: error.message }, { status: 503 });
      if (error instanceof NotConnected) return Response.json({ ok: false, error: "not_connected" }, { status: 400 });
      const why = error instanceof ProviderError ? error.message : "it could not be reached";
      console.error("a test meeting failed", error);
      // Said where every meeting that could not be made is said: under Recent problems.
      await logProblem(store.statsId, provider, action === "test" ? "A test meeting could not be made" : action === "movetest" ? "The test meeting could not be moved" : "The test meeting could not be deleted", why);
      return Response.json({ ok: false, error: "meeting_failed" }, { status: 502 });
    }
  }
  try {
    const { view: was, providerAccessRemoved } = await disconnectFor(store.statsId, provider);
    // Forgotten here either way; when the provider did not confirm it took the access back in this request, the page
    // and the email say so. Nothing there counts as not confirmed: an earlier try may have stopped after forgetting it,
    // its answer lost, and the retry has nothing to ask the provider (G review 5815599962).
    const unconfirmed = providerAccessRemoved === false;
    if (was) after(() => noticeCreator(store, { kind: "meeting-disconnected", name: ACCOUNT_NAMES[provider], account: was.account, ...(unconfirmed ? { provider, providerAccessRemoved: false as const } : {}) }));
    return Response.json({ ok: true, view: await meetView(store.statsId, store), ...(providerAccessRemoved === false ? { providerAccessRemoved: false } : {}) });
  } catch (error) {
    console.error("disconnecting a meeting account failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
