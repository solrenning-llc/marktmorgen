import { Line } from "@/components/sales-blocks";
import { postBlocks } from "@/lib/store-blog-rules";

/** A blog post's words as the page draws them (lib/store-blog.ts, postBlocks): headings, paragraphs, lists and links. */
export function PostBody({ body }: { body: string }) {
  const blocks = postBlocks(body);
  return (
    <div className="st-about st-post leading-relaxed">
      {blocks.map((block, i) =>
        block.kind === "heading" ? (
          <h2 key={i} className="font-display text-2xl font-semibold leading-tight">
            {block.text}
          </h2>
        ) : block.kind === "list" ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <Line pieces={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {block.lines.map((row, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                <Line pieces={row} />
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}
