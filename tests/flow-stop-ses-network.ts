/** Test-only network bridge: run the real SES protocol, keeping the original
 * stop-during-send observer at the provider POST. No workflow is replaced. */
import { installSesMailFixture } from "./ses-mail-fixture";
import { sesConfig as realConfig, isSesConfigured as realConfigured } from "../lib/ses";
export * from "../lib/ses";

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  // The test installs its observer after imports; capture it on first use.
  const observe = globalThis.fetch;
  const fixture = installSesMailFixture({
    fallback: observe,
    onSes: async message => {
      const response = await observe("https://api.resend.com/emails", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...message, to: message.to }),
      });
      if (!response.ok) return response;
      const body: unknown = await response.json();
      // Never manufacture acceptance from an absent/malformed test ACK.
      const id = body && typeof body === "object" && Object.hasOwn(body, "id")
        ? (body as { id?: unknown }).id : null;
      if (typeof id !== "string" || !id.length) throw new TypeError("Synthetic provider acceptance is unknown");
      return new Response(JSON.stringify({ MessageId: id }), { status: response.status });
    },
  });
  fixture.configure();
}
export function sesConfig() { install(); return realConfig(); }
export function isSesConfigured() { install(); return realConfigured(); }
