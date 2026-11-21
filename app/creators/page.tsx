import type { Metadata } from "next";
import Link from "next/link";
import { Icon, iconFor } from "@/components/icons";
import { CreatorResearchForm } from "@/components/creator-research-form";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav-server";
import { SUPPORT_EMAIL } from "@/lib/creator-research";

export const metadata: Metadata = {
  title: "Selling digital products? Tell me what's broken — Marktmorgen",
  description:
    "Marktmorgen is talking to creators who sell guides, courses, templates and paid calls before building its next tool. Share what's hard about selling online.",
};

const PROMISES = [
  {
    emoji: "🔒",
    title: "Only to decide what gets built",
    body: "Your answers are used for that and nothing else.",
    tint: "bg-violet-brand/10 text-violet-deep",
  },
  {
    emoji: "🙅",
    title: "Never sold, never shared",
    body: "They do not go to anyone else's marketing list. Ever.",
    tint: "bg-pink-brand/10 text-pink-brand",
  },
  {
    emoji: "✉️",
    title: "Email only if you checked a box",
    body: "And only about what that box says.",
    tint: "bg-amber-brand/15 text-amber-brand",
  },
  {
    emoji: "🗑️",
    title: "Deleted whenever you ask",
    body: `Write to ${SUPPORT_EMAIL} and they are gone.`,
    tint: "bg-mint-brand/15 text-mint-deep",
  },
];

export default function CreatorsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />

      <main id="content" className="flex-1">
        <section className="surface-navy nb-grid-lines on-dark overflow-hidden">
          <div className="container-page grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
            <div>
              <p className="eyebrow">Creator research</p>
              <h1 className="t-h1 balance mt-5 text-white">
                Selling digital products?{" "}
                <span className="serif font-normal text-[#cfc4ff]">Tell me what&apos;s broken.</span>
              </h1>
              <div className="t-lead mt-6 max-w-2xl space-y-4 text-white/80">
                <p>
                  We build Marktmorgen. Before we build our next tool, we are talking to creators
                  who sell guides, courses, templates and paid calls from their link in bio.
                </p>
                <p>
                  This is not a sales page. There is nothing to buy. I want to know what is hard about selling online today,
                  in your own words.
                </p>
              </div>
              <p className="mt-8 flex items-center gap-2 text-[0.9375rem] text-white/80">
                <Icon name="clock" size={18} className="text-violet-lift" />
                Two minutes, eight questions, three of them optional
              </p>
            </div>
            {/*
              What happens to an answer, said before the form is reached
              rather than under it. Somebody deciding whether to type into a
              box wants this here, not after they have already typed.
            */}
            <div className="rounded-[var(--r-lg)] border border-white/14 bg-white/[0.05] p-6 backdrop-blur-sm sm:p-7">
              <p className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-white/70">
                Before you answer
              </p>
              <ul className="mt-4 space-y-4 text-[0.9375rem] text-white/80">
                {[
                  { icon: "user" as const, text: "One person reads them — me — and nobody else." },
                  { icon: "target" as const, text: "They go on the list that decides what gets built next." },
                  { icon: "mail" as const, text: "No email back unless you check the box asking for one." },
                ].map((i) => (
                  <li key={i.text} className="flex gap-3">
                    <span className="icon-tile icon-tile-sm">
                      <Icon name={i.icon} size={17} />
                    </span>
                    <span className="pt-1.5">{i.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="py-12 sm:py-16">
          <div className="container-narrow">
            <div className="card p-6 sm:p-10">
              <CreatorResearchForm />
            </div>
          </div>
        </section>

        <section className="surface-sand section-tight">
          <div className="container-page">
            <h2 className="t-h2 text-center">What happens with your answers</h2>
            <div className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-2">
              {PROMISES.map((item) => (
                <article key={item.title} className="card-flat flex gap-4 p-6">
                  <span className="icon-tile">
                    <Icon name={iconFor(item.emoji)} size={22} />
                  </span>
                  <span className="min-w-0">
                    <h3 className="font-semibold text-ink">{item.title}</h3>
                    <p className="mt-1 [overflow-wrap:anywhere] text-[0.9375rem] text-ink-soft">{item.body}</p>
                  </span>
                </article>
              ))}
            </div>

            <div className="mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
              <Link href="/demo" className="btn btn-primary btn-lg">
                See the live demo store
              </Link>
              <Link href="/" className="link-arrow">
                Back to the home page
                <Icon name="arrow-right" size={16} className="arrow" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
