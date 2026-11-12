/**
 * The email's "Can everyone read it?" panel (components/mail-access-review.tsx) on its own, for
 * tests/e2e/mail-access-review.mjs: a text box stands for the email's text, as in the studio, and the
 * panel sits in the same sand box as the "Check before it goes out" step. Nothing is sent anywhere.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MailAccessReview } from "@/components/mail-access-review";

function World({ start }: { start: string }) {
  const [body, setBody] = useState(start);
  return (
    <div className="mx-auto max-w-2xl p-4">
      <h1 className="text-xl font-semibold">Email</h1>
      <label htmlFor="mail-body" className="field-label">Email</label>
      <textarea id="mail-body" className="field min-h-56" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="mt-4 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink">
        <h2 className="font-semibold">Check before it goes out</h2>
        <MailAccessReview
          body={body}
          onChange={setBody}
          onShow={(start, end) => {
            const box = document.getElementById("mail-body") as HTMLTextAreaElement;
            box.focus();
            box.setSelectionRange(start, end);
          }}
        />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
(window as unknown as { harness: { mount: (body: string) => void } }).harness = {
  mount: (body: string) => root.render(<World key={body} start={body} />),
};
