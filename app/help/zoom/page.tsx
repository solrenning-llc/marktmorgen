import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { NewTab } from "@/components/new-tab";

export const metadata: Metadata = {
  title: "Zoom app guide — Marktmorgen",
  description:
    "How to add the Marktmorgen app to your Zoom account, what it does with your meetings, and how to remove it.",
};

const link = "text-black underline underline-offset-2 hover:no-underline";

/**
 * The guide Zoom's Marketplace listing points to: adding, using and removing
 * the app, and what it touches. Plain words, no promise beyond what the code
 * does (lib/meet-providers.ts, lib/meet-connect.ts, lib/call-meetings.ts,
 * lib/event-meetings.ts, app/api/integrations/zoom).
 */
export default function ZoomGuidePage() {
  return (
    <LegalPage title="Zoom for Marktmorgen" lastUpdated="November 8, 2026">
      <p>
        Marktmorgen is a link-in-bio store where creators sell digital
        products, courses, memberships and paid video calls. The Zoom app lets
        a creator have a Zoom meeting made on their own Zoom account for each
        call booked in their store, and for their community&apos;s live events,
        without copying and pasting links.
      </p>
      <p>
        Connecting Zoom becomes available to every store once Zoom approves our
        Marketplace listing. Until then, the Zoom option is shown to anyone who
        opens Video calls from the listing, or from this link:{" "}
        <Link href="/studio/meetings?from=zoom" className={link}>marktmorgen.com/studio/meetings?from=zoom</Link>.
        If you are not logged in yet, log in or start a store first; your
        browser remembers that you came for Zoom, and the Zoom card is there
        when you open Video calls.
      </p>

      <LegalSection title="Adding the app" id="add">
        <p>You need a Marktmorgen store and a Zoom account. Only the store&apos;s owner or an Admin can connect it.</p>
        <ol className="list-decimal space-y-2 pl-6">
          <li>Sign in to your studio and open <strong className="text-black">Video calls</strong>.</li>
          <li>Under Zoom, click <strong className="text-black">Connect Zoom</strong>.</li>
          <li>Zoom asks you to sign in if you are not signed in already, then shows the permissions Marktmorgen asks for. Click <strong className="text-black">Allow</strong>.</li>
          <li>You come back to Video calls, where Zoom shows as <strong className="text-black">Connected</strong>, with the account&apos;s address. The store&apos;s owner is emailed each time an account is connected or disconnected.</li>
          <li>
            To check that it works, click <strong className="text-black">Make a test meeting</strong> under Zoom. One scheduled
            meeting is made on your Zoom account, an hour from now, with nobody invited, and its join link is shown. Click{" "}
            <strong className="text-black">Delete the test meeting</strong> to remove it from your Zoom account.
          </li>
        </ol>
      </LegalSection>

      <LegalSection title="Using it" id="use">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong className="text-black">Calls.</strong> Under Products, open a call&apos;s hours or sessions and choose{" "}
            <strong className="text-black">Zoom (automatic)</strong> in Where the call happens. Each booking of a one-to-one call
            gets its own scheduled meeting on your Zoom account; a group call or a live session on a set date gets one meeting per time,
            shared by everyone booked into it. The join link goes into the buyer&apos;s confirmation email, reminders and calendar file.
          </li>
          <li>
            <strong className="text-black">Live events.</strong> When you schedule a community live event, choose Zoom (automatic)
            under Where. The event gets one meeting, and members see its link on the event&apos;s page from 15 minutes before it starts.
          </li>
          <li>
            <strong className="text-black">Changes.</strong> When a buyer moves a booking, its meeting moves too. After a full refund
            of a one-to-one call, or when you cancel an event, its meeting is deleted.
          </li>
          <li>
            <strong className="text-black">Starting.</strong> Click <strong className="text-black">Start in Zoom</strong> next to a call under Upcoming calls in your studio, or next to a live event in the community section of your studio, and Marktmorgen
            asks Zoom for a fresh start link, so you join as the host.
          </li>
          <li>
            <strong className="text-black">If a meeting cannot be made.</strong> The booking gets your own meeting link, or a private
            video room when you have none, so nobody waits, and we keep trying for about 16 hours.
          </li>
        </ul>
        <p>
          How many people can join, and for how long, is decided by your Zoom plan.
        </p>
      </LegalSection>

      <LegalSection title="What the app can see and do" id="data">
        <p>
          Marktmorgen asks Zoom to create, read, update and delete meetings on your account, and to see your account&apos;s
          name and email address, to show which account is connected. It only ever changes or deletes meetings it created.
          It does not read your other meetings, recordings, chats or participant lists. We keep the IDs and join links of
          the meetings we made, your Zoom user ID, name and email address, and the access and refresh tokens, which are encrypted. More in our{" "}
          <Link href="/privacy#google-zoom" className={link}>Privacy Policy</Link>.
        </p>
      </LegalSection>

      <LegalSection title="Removing the app" id="remove">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong className="text-black">From your studio.</strong> Open Video calls and click{" "}
            <strong className="text-black">Disconnect</strong> under Zoom. We ask Zoom to cancel our token. When Zoom confirms it,
            our access ends. We also disconnect the account here and delete what we kept about the connection. If Zoom does not
            confirm it, we tell you on the screen and in the email to the store&apos;s owner, and you can remove the app yourself
            in Zoom, as the next step shows.
          </li>
          <li>
            <strong className="text-black">From Zoom.</strong> Sign in at{" "}
            <a href="https://marketplace.zoom.us/" className={link} rel="noopener noreferrer" target="_blank">marketplace.zoom.us<NewTab /></a>, open{" "}
            <strong className="text-black">Manage</strong>, then <strong className="text-black">Added Apps</strong>, and click{" "}
            <strong className="text-black">Remove</strong> next to Marktmorgen. Zoom tells us at once; we forget the connection and
            its tokens, and the store&apos;s owner is emailed.
          </li>
        </ul>
        <p>
          Either way, meetings already made stay on your Zoom account and keep working. New bookings use your own link, or a
          private video room, until you connect again.
        </p>
      </LegalSection>

      <LegalSection title="Help" id="help">
        <p>
          Write to{" "}
          <a href="mailto:support@marktmorgen.com" className={link}>support@marktmorgen.com</a>. The rest of the product is
          explained in the <Link href="/help" className={link}>help center</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
