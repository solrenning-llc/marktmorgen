import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { countStudio, studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { StudentsBulk } from "@/components/students-bulk";
import { readKind } from "@/lib/catalog";
import { lessonCount, readCourse } from "@/lib/course";
import { can } from "@/lib/team-roles";
import { studentList } from "@/lib/student-bulk";
import { MAX_STUDENT_ACTION, PROGRESS_WORDS, STUDENTS_PER_PAGE, filterStudents, readFilters, readPageNumber, readStudentCursor } from "@/lib/student-bulk-rules";
import { count } from "@/lib/bulk-label-rules";

export const metadata: Metadata = {
  title: "Students — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * A course's students, one page of STUDENTS_PER_PAGE at a time, filtered by
 * progress, access and label, many selected at once and changed together:
 * access removed or given back, a label on or off, or downloaded as a file
 * (279 [H3-4], unit 1). For whoever may change the store's courses
 * ("products"), as taking one student off a course; labels for whoever may
 * change the list ("send"); the file for whoever may download addresses
 * ("export"). What reading the page costs at its most, in commands and in
 * bytes, is taken in studio requests before anything is read
 * (lib/student-bulk.ts, studentsPageUnits); the students' labels, the
 * costliest part, are read only when a label is asked for.
 */
export default async function StudioStudentsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "products");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const canTag = can(view.role, "send");
  const canExport = can(view.role, "export");
  const courses = (await readKind(store, "course")).filter((p) => p.course);
  const product = courses.find((p) => p.id === query.product) ?? courses[0] ?? null;
  const course = product?.course ? await readCourse(product.course.id) : null;
  const typed = readFilters(query);
  const filters = canTag ? typed : { ...typed, label: "" };
  const cursor = readStudentCursor(query.after);
  const pageNumber = cursor === "0" ? 1 : readPageNumber(query.page);
  // Labels cost the most to read (each contact's whole record): read only when a label is asked for.
  const withLabels = canTag && Boolean(filters.label);
  // The studio's own sentence when it would not pay for the reading, kept to show in its place.
  const refusals: string[] = [];
  const read = course
    ? await studentList(
        store,
        course,
        cursor,
        async (units) => {
          if (units === 0) return true;
          const counted = await countStudio(store, null, units).catch(() => null);
          if (!counted?.ok && counted?.message) refusals.push(counted.message);
          return counted?.ok === true;
        },
        withLabels,
      )
    : null;
  const lessons = course ? lessonCount(course) : 0;
  const filtered = read ? filterStudents(read.lines, lessons, filters) : { shown: [], labelsUnknown: 0 };
  const link = (after: string, page: number) =>
    studioPath(
      store,
      [
        product ? `product=${encodeURIComponent(product.id)}` : "",
        filters.progress !== "any" ? `progress=${filters.progress}` : "",
        filters.access !== "any" ? `access=${filters.access}` : "",
        filters.label ? `label=${encodeURIComponent(filters.label)}` : "",
        after !== "0" ? `after=${after}` : "",
        after !== "0" ? `page=${page}` : "",
      ]
        .filter(Boolean)
        .join("&"),
      "students",
    );

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: product ? studioPath(store, "", `course/${product.id}`) : studioPath(store), label: "Back to the course", short: "Course" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page max-w-5xl pb-20 pt-10 sm:pt-14">
          <nav aria-label="Breadcrumb" className="text-sm text-ink-soft">
            <ol className="flex flex-wrap gap-x-2">
              <li>
                <Link href={studioPath(store)} className="inline-flex min-h-11 items-center underline">Studio</Link>
                <span aria-hidden="true"> /</span>
              </li>
              {product ? (
                <li>
                  <Link href={studioPath(store, "", `course/${product.id}`)} className="inline-flex min-h-11 items-center underline">{product.title}</Link>
                  <span aria-hidden="true"> /</span>
                </li>
              ) : null}
              <li aria-current="page" className="inline-flex min-h-11 items-center">Students</li>
            </ol>
          </nav>
          <h1 className="t-h2 mt-3">Students</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`Select students to remove their access, give it back, label them or download them as a file. You see exactly how many will change before anything is saved, and you can undo it right after. Up to ${MAX_STUDENT_ACTION.toLocaleString("en-US")} students at a time.`}
          </p>

          {!product || !course ? (
            <p className="mt-8 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">You have no courses yet. Make a product a course in the studio, and its students are listed here.</p>
          ) : (
            <>
              <form method="get" action="/studio/students" className="card mt-8 grid gap-4 p-6 sm:grid-cols-2 sm:p-8">
                <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink sm:col-span-2">Which students</h2>
                {store.sid ? <input type="hidden" name="store" value={store.sid} /> : null}
                <div className="text-sm">
                  <label htmlFor="students-course" className="field-label block">Course</label>
                  <select id="students-course" name="product" className="field mt-1 min-h-11" defaultValue={product.id}>
                    {courses.map((p) => (
                      <option key={p.id} value={p.id}>{p.title}</option>
                    ))}
                  </select>
                </div>
                <div className="text-sm">
                  <label htmlFor="students-progress" className="field-label block">Progress</label>
                  <select id="students-progress" name="progress" className="field mt-1 min-h-11" defaultValue={filters.progress}>
                    <option value="any">Any</option>
                    {(["none", "started", "finished"] as const).map((value) => (
                      <option key={value} value={value}>{PROGRESS_WORDS[value]}</option>
                    ))}
                  </select>
                </div>
                <div className="text-sm">
                  <label htmlFor="students-access" className="field-label block">Access</label>
                  <select id="students-access" name="access" className="field mt-1 min-h-11" defaultValue={filters.access}>
                    <option value="any">Any</option>
                    <option value="active">Has access</option>
                    <option value="removed">Access removed</option>
                  </select>
                </div>
                {canTag ? (
                  <div className="text-sm">
                    <label htmlFor="students-label-filter" className="field-label block">Label on their contact</label>
                    <input id="students-label-filter" name="label" className="field mt-1 min-h-11" defaultValue={filters.label} aria-describedby="students-label-filter-hint" />
                    <span id="students-label-filter-hint" className="mt-1 block text-xs text-ink-soft">{"Leave empty for any. Each student's labels are shown when you choose one. Example: VIP"}</span>
                  </div>
                ) : null}
                <div className="sm:col-span-2">
                  <button type="submit" className="btn btn-secondary">Show these students</button>
                </div>
              </form>

              <section className="mt-8" aria-labelledby="students-list-title">
                <h2 id="students-list-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">{`Students of ${product.title}`}</h2>
                {!read ? (
                  <p className="mt-3 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink" role="alert">
                    {refusals[0] || "The students couldn't be read just now. Nothing was changed. Try again in a minute."}
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-sm text-ink-soft">
                      {`${count(read.total, "student has", "students have")} opened this course. This page has ${count(read.lines.length, "student", "students")}, and ${filtered.shown.length.toLocaleString("en-US")} ${filtered.shown.length === 1 ? "matches" : "match"} your choices. Choices apply to this page only.`}
                    </p>
                    {filtered.labelsUnknown ? (
                      <p className="mt-2 text-sm text-ink">{`${count(filtered.labelsUnknown, "student's labels", "students' labels")} couldn't be read, so ${filtered.labelsUnknown === 1 ? "that student is" : "those students are"} not shown for this label.`}</p>
                    ) : null}
                    {filtered.shown.length ? (
                      <StudentsBulk key={`${product.id}:${cursor}:${filters.progress}:${filters.access}:${filters.label}`} productId={product.id} courseTitle={product.title} lessons={lessons} lines={filtered.shown} canTag={canTag} canExport={canExport} labelsShown={withLabels} />
                    ) : (
                      <p className="mt-4 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">No student on this page matches. Change your choices above, or go to the next page.</p>
                    )}
                    <nav aria-label="Pages of students" className="mt-6 flex flex-wrap items-center gap-4 text-sm">
                      <p aria-current="page" className="inline-flex min-h-11 items-center font-semibold text-ink">{`Page ${pageNumber.toLocaleString("en-US")}`}</p>
                      {cursor !== "0" ? (
                        <Link href={link("0", 1)} className="inline-flex min-h-11 items-center underline">First page of students</Link>
                      ) : null}
                      {read.next !== "0" ? (
                        <Link href={link(read.next, pageNumber + 1)} className="inline-flex min-h-11 items-center underline">{`Next page of students (page ${(pageNumber + 1).toLocaleString("en-US")}, up to ${STUDENTS_PER_PAGE})`}</Link>
                      ) : (
                        <p className="inline-flex min-h-11 items-center text-ink-soft">This is the last page.</p>
                      )}
                    </nav>
                  </>
                )}
              </section>
            </>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
