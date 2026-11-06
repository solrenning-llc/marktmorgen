import { NewTab } from "@/components/new-tab";
import type { Block, Piece } from "@/lib/product-about";

/**
 * A product's full description as its page draws it: paragraphs, lists and
 * links (lib/product-about.ts, aboutBlocks). Shared by the product page and
 * the studio's preview of it (487 [IT4], pattern 7), so the two can never
 * draw it differently.
 */

/** One line of a description, with its links drawn as links. */
function Line({ pieces, language }: { pieces: Piece[]; language: unknown }) {
  return (
    <>
      {pieces.map((piece, i) =>
        piece.href ? (
          <a key={i} href={piece.href} target="_blank" rel="noopener noreferrer nofollow ugc">
            {piece.text}
          <NewTab language={language} /></a>
        ) : (
          <span key={i}>{piece.text}</span>
        ),
      )}
    </>
  );
}

export function ProductAbout({ blocks, language }: { blocks: Block[]; language: unknown }) {
  return (
    <div className="st-about mt-6 leading-relaxed">
      {blocks.map((block, i) =>
        block.kind === "list" ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <Line pieces={item} language={language} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {block.lines.map((line, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                <Line pieces={line} language={language} />
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}
