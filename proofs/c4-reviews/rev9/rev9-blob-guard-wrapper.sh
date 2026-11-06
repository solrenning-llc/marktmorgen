#!/bin/sh
# Proof (#2837): a new Blob HEAD added through a wrapper (lib/file-store.ts headFile) is not seen by BLOB_SITES,
# while the same HEAD imported from @/lib/blob is. Run from a checkout of the PR head; restores the tree after.
set -e
W="$1"; RUN="$2"
cd "$W"
printf 'import { headFile } from "@/lib/file-store";\nexport async function probe(p: string) { return headFile(p); }\n' > lib/rev9-wrapper-caller.ts
echo "--- new caller through the wrapper:"; node "$RUN" "$W" blob-sites.test.ts | head -1
printf 'import { head } from "@/lib/blob";\nexport async function probe(p: string) { return head(p); }\n' > lib/rev9-wrapper-caller.ts
echo "--- same HEAD imported from @/lib/blob:"; node "$RUN" "$W" blob-sites.test.ts | head -1
rm lib/rev9-wrapper-caller.ts
