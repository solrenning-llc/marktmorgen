import { FEATURE_CAPTURES } from "@/lib/feature-captures";

export function hasFeatureCapture(slug: string): boolean {
  return FEATURE_CAPTURES.some(capture => capture.slug === slug);
}

/** A dated photograph of the real interface, never a customer testimonial. */
export function FeatureCapture({ slug }: { slug: string }) {
  const capture = FEATURE_CAPTURES.find(item => item.slug === slug);
  if (!capture) return null;
  const date = new Date(capture.capturedAt).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
  return (
    <figure className="w-full min-w-0 max-w-2xl overflow-hidden rounded-2xl border border-line bg-white text-ink" data-feature-capture={capture.slug}>
      {/* Local static pixels: no remote image host, optimizer or runtime capture. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={capture.src} alt={capture.alt} width={capture.width} height={capture.height} loading="lazy" decoding="async" className="h-auto w-full object-contain" />
      <figcaption className="border-t border-line px-5 py-4 text-base leading-relaxed">
        <strong className="block font-semibold">{capture.context} · actual interface</strong>
        Captured {date} with isolated fictional test content and a substitute font. This is not a customer result.
      </figcaption>
    </figure>
  );
}
