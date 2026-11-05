/**
 * The one place that says which repository is ours. GitHub keeps a repository's
 * numeric ID when the repository is renamed or moved to another owner, and no
 * fork or copy ever has it, so the ID is checked first; the original name stays
 * accepted so nothing changes while the repository is where it is today.
 */
export const OWNED_REPOSITORY_ID="1334793724";
export const ORIGINAL_REPOSITORY="viniciussucupira/marktmorgen";
/** @param {Record<string, string | undefined>} env GitHub Actions environment. */
export function ownedRepositoryEnv(env){
 return env.GITHUB_REPOSITORY_ID===OWNED_REPOSITORY_ID||env.GITHUB_REPOSITORY===ORIGINAL_REPOSITORY;
}
/** @param {{id?: unknown, full_name?: unknown} | undefined} repository The event payload's repository. */
export function ownedRepositoryEvent(repository){
 return String(repository?.id)===OWNED_REPOSITORY_ID||repository?.full_name===ORIGINAL_REPOSITORY;
}
