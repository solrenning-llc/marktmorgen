import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readKindExact } from "@/lib/catalog";
import { readPaths } from "@/lib/learning-paths";
import type { StoredPath } from "@/lib/learning-path-rules";
import { courseChoices } from "@/lib/learning-paths-studio";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { LearningPathsEditor } from "@/components/learning-paths-editor";

export const metadata: Metadata = {
  title: "Learning paths — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * A store's learning paths (249 [ST2], unit 3): several of its courses in
 * the order the creator sets, kept by lib/learning-paths.ts. For whoever may
 * change products. The courses are read exactly (readKindExact) and the kept
 * paths too (readPaths): when either does not read, no editor is drawn, so
 * nothing is saved over what could not be seen (rule 24).
 */
export default async function StudioLearningPathsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "products");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;

  let paths: StoredPath[] | null = null;
  let courses: { id: string; title: string }[] = [];
  try {
    courses = courseChoices(await readKindExact(store, "course"));
    paths = store.statsId ? await readPaths(store.statsId) : null;
  } catch {
    paths = null;
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page max-w-3xl pb-20 pt-10 sm:pt-14">
          <StudioTrail store={store} here="Learning paths" />
          <h1 className="t-h2 mt-3">Learning paths</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Put several of your courses in order. Choose whether each course opens when the one before it is finished, or whether all of them are open at once. Your courses themselves, their lessons and their prices do not change.
          </p>
          <div className="mt-8">
            <LearningPathsEditor initial={paths} courses={courses} />
          </div>
        </main>
      </StudioStorePin>
    </div>
  );
}
