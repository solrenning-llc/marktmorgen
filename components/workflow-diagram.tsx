"use client";

/**
 * The picture of a workflow (391 [CX2], unit 1; added 12 November 2026): its
 * steps as boxes, top to bottom, with an arrow for every way out of each,
 * laid out by lib/flow-map.ts from the same routing the job runs.
 *
 * Everything is drawn in the text colour (currentColor), so it has the
 * text's contrast in light and dark, and follows the system's colours in
 * forced-colours mode. "Yes" and "No" are words on their arrows, and "No"
 * is also dashed: nothing is told by colour alone. The list of steps that
 * comes after the picture says everything it shows, so the picture is one
 * image with a name that points there, and a screen reader reads the list.
 * Wide workflows scroll sideways inside their own box, as a diagram may;
 * the page itself never does.
 */
import { useId } from "react";
import { type FlowMapLayout, LINE_HEIGHT } from "@/lib/flow-map";

const FONT = 14;

export function WorkflowDiagram({ layout, steps }: { layout: FlowMapLayout; steps: number }) {
  const id = useId();
  const head = `${id}-head`;
  const title = `${id}-title`;
  return (
    <figure className="mt-2 max-w-full overflow-x-auto text-ink" data-workflow-diagram>
      <svg
        role="img"
        aria-labelledby={title}
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block"
        fill="none"
        stroke="currentColor"
      >
        <title id={title}>{`Picture of the ${steps === 1 ? "step" : `${steps} steps`} and where each one leads. The same steps are listed after it.`}</title>
        <defs>
          <marker id={head} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" stroke="none" />
          </marker>
        </defs>
        {layout.boxes.map((box) => (
          <g key={box.index}>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={box.end ? box.h / 2 : 8} strokeWidth={box.end ? 2 : 1.5} />
            {box.lines.map((line, k) => (
              <text
                key={k}
                x={box.end ? box.x + box.w / 2 : box.x + 12}
                y={box.y + 14 + LINE_HEIGHT * k + FONT}
                textAnchor={box.end ? "middle" : "start"}
                fontSize={FONT}
                fontWeight={box.end ? 600 : 400}
                fill="currentColor"
                stroke="none"
              >
                {line}
              </text>
            ))}
          </g>
        ))}
        {layout.arrows.map((arrow) => (
          <g key={`${arrow.from}-${arrow.kind}`}>
            <polyline
              points={arrow.points.map(([x, y]) => `${x},${y}`).join(" ")}
              strokeWidth={1.5}
              strokeDasharray={arrow.kind === "no" ? "6 4" : undefined}
              markerEnd={`url(#${head})`}
            />
            {arrow.label ? (
              <text x={arrow.label.x} y={arrow.label.y} fontSize={13} fontWeight={600} fill="currentColor" stroke="none">
                {arrow.label.text}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    </figure>
  );
}
