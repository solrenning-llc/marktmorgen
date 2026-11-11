import type { Metadata, Viewport } from "next";
import { StudioApp } from "@/components/studio-app";
import { SkipLink } from "@/components/skip-link";

/**
 * Around every page of the studio: its own web app manifest, so a creator can
 * put the studio on their phone's home screen as an app of its own ("Studio",
 * opening on /studio and covering only the studio's pages), and the service
 * worker that shows their notifications (lib/phone-alerts.ts). On an iPhone
 * or an iPad, installing it this way is what lets it receive notifications
 * at all (iOS 16.4 and later). Nothing of the studio is ever kept offline:
 * the worker caches nothing (public/studio-sw.js).
 */
export const metadata: Metadata = {
  manifest: "/studio.webmanifest",
  applicationName: "Marktmorgen Studio",
  appleWebApp: { capable: true, title: "Studio", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function StudioLayout({ children }: LayoutProps<"/studio">) {
  return (
    <>
      <SkipLink />
      {/* Marks the studio's pages for the 44 px target floor in app/globals.css (WCAG 2.5.5); draws no box of its own. */}
      <div data-studio="" className="contents">
        {children}
      </div>
      <StudioApp />
    </>
  );
}
