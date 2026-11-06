/**
 * Whether a community has a public About page (233 [SK1]), and whether that
 * page shows how many people have joined and how active it is. Kept in the
 * community's settings (lib/community.ts, CommunityConfig.page) and changed
 * only by the creator, from the studio (app/api/store/community/manage,
 * action "about-page").
 *
 * Off by default, like everything else that shows the community to people
 * who are not in it: a community written down before the page existed reads
 * as off. The counts are a second choice, and only with the page on.
 *
 * Its own file, with no import of lib/community.ts, so the settings can be
 * read there without a cycle (the same as lib/community-dm.ts's DmSetting).
 */
export type AboutSetting = {
  /** The page exists at /@handle/community/about. Off: not found. */
  on: boolean;
  /** It shows how many people have joined and the posts of the last 30 days. */
  counts: boolean;
};

export const NO_ABOUT_PAGE: AboutSetting = Object.freeze({ on: false, counts: false }) as AboutSetting;

export function parseAboutSetting(raw: unknown): AboutSetting {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...NO_ABOUT_PAGE };
  const value = raw as { on?: unknown; counts?: unknown };
  const on = value.on === true;
  return { on, counts: on && value.counts === true };
}
