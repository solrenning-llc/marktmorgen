export * from "/home/user/marktmorgen/.claude/worktrees/sweepA4/lib/catalog";
export async function readListings(_store: unknown, ids: string[]) { return ids.map((id) => ({ id, title: "Course " + id, course: { id: "course1" } })) as any; }
