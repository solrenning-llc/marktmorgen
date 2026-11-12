import { ImageResponse } from "next/og";
import { BLOG_POSTS, postBySlug } from "@/lib/blog";

/**
 * The picture that shows up when an article is pasted into a chat or a post.
 *
 * Before this existed, every article shared as the home page: the card carried
 * the site's headline and the site's image, whatever you had actually linked.
 * An article written to be passed around that shares as something else is an
 * article thrown away at the last step.
 *
 * Drawn from the post itself — its own title and its own two colours — so a
 * new article gets a card the moment it is written, with nothing to remember.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "An article from The Marktmorgen Journal";

/** Only the listed pages exist: any other address is a plain 404, never rendered and stored in the ISR cache for that
 * address (tests/c1-cost-unknown-slugs.test.ts). */
export const dynamicParams = false;

export function generateStaticParams() {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = postBySlug(slug);

  // A missing post still has to return an image rather than throw, because
  // this runs where a 404 page would otherwise be rendered.
  const title = post?.title ?? "The Marktmorgen Journal";
  const kicker = post?.kicker ?? "Marktmorgen";
  const from = post?.from ?? "#6c3bff";
  const to = post?.to ?? "#ff3d8a";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          backgroundImage: `linear-gradient(135deg, ${from}, ${to})`,
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            opacity: 0.85,
          }}
        >
          {kicker}
        </div>

        <div
          style={{
            display: "flex",
            fontSize: title.length > 60 ? 64 : 76,
            fontWeight: 800,
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
          }}
        >
          {title}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            fontSize: 30,
            fontWeight: 600,
          }}
        >
          <div style={{ display: "flex" }}>The Marktmorgen Journal</div>
          <div style={{ display: "flex", opacity: 0.85 }}>marktmorgen.com</div>
        </div>
      </div>
    ),
    size,
  );
}
