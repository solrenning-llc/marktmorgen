/** 244 [SP1]: the list of free tools (lib/free-tools.ts), each with its one sentence. */
import Link from "next/link";
import { FREE_TOOLS, FREE_TOOLS_PATH } from "@/lib/free-tools";

export function FreeToolsHub() {
  return (
    <ul className="grid max-w-3xl gap-4">
      {FREE_TOOLS.map((tool) => (
        <li key={tool.slug} className="rounded-2xl bg-paper p-5 ring-1 ring-line">
          <h2 className="t-h3">
            <Link href={`${FREE_TOOLS_PATH}/${tool.slug}`} className="underline underline-offset-4">{tool.title}</Link>
          </h2>
          <p className="mt-2">{tool.sentence}</p>
        </li>
      ))}
    </ul>
  );
}
