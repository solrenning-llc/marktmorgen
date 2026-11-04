# More structured data: what each store page may mark up (639 [GL7](20))

Read on 4 November 2026 from schema.org and Google Search Central only (no account, no tool that submits anything). Each point below is quoted or closely paraphrased from the page named, with the date the page shows. Nothing here claims a rich result: Google "does not guarantee" one appears.

## The rules that apply to every page

- "Don't mark up content that is not visible to readers of the page", and do not use structured data to mislead or to impersonate anyone ([general guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies), last updated 10 July 2026).
- A page blocked by `noindex` gets no rich result, so a page Marktmorgen keeps out of search (the business card, a buyer's private podcast) is not marked up at all.

## Courses

- **The single-course result is gone.** The Course info page now redirects to Google's changelog, whose 9 September 2025 entry says the course info type is no longer shown in Google Search ([search updates](https://developers.google.com/search/updates)).
- **The course list stays** ([course list](https://developers.google.com/search/docs/appearance/structured-data/course), last updated 8 September 2026), in English, in every region Google Search is in:
  - at least three courses, on a page that lists them (an `ItemList` of `ListItem`s with `position` and the course's own canonical `url`), each course's own page carrying its `Course` markup;
  - `Course` needs `name` and `description` (shown up to 60 characters); `provider` is recommended;
  - a name may not carry a promotional phrase, a price ("Learn ukulele - only $30!"), a discount or a purchase opportunity;
  - only for a curriculum of lessons or modules with an educational outcome, led by instructors; not a single short video or a general public event.
  - `offers`, `hasCourseInstance`, `courseMode` and `courseWorkload` exist on schema.org ([Course](https://schema.org/Course), [CourseInstance](https://schema.org/CourseInstance)) but are not in Google's supported list, so they are not sent.
- **Built:** `courseData` and `courseListData` in `lib/page-structured-data.ts`, with `MIN_COURSE_LIST` = 3. Names and descriptions are read as a reader sees them (compatibility forms folded, hidden format characters removed, spaces single). A course is not marked up when its name has a price in any currency sign or code ("30 USD", "€30", "＄３０"), a percentage, "N off", "on sale", "discount", "half price", "limited time", "save N", "only N", "buy now", "order now" or "enroll now", when it has no description, or when its address is not an https page of the store's own site. The same page under several spellings (a trailing slash, a fragment) counts once. The list marks up every course the page lists or none, so it never says less than the page shows. Ordinary words ("Gluten-free", "Off-grid", "The Only…", "Free …") are kept. A provider with no name is left out; a description is cut at 5,000 characters.
- **Not yet wired:** the course's sales page (`app/[handle]/p/[product]/page.tsx`) and the store's page that lists its courses (`app/[handle]/page.tsx`) are reserved by Claude 2. The unit that wires them adds `<JsonLd data={courseData(...)} />` for a course product with lessons and `courseListData` on the store page, from what each page shows.

## Live events

- Google's Event result ([event](https://developers.google.com/search/docs/appearance/structured-data/event), last updated 8 September 2026): "Virtual experiences that have no real-world component aren't supported. Events must take place in a physical location", and "Events that require a membership, or invitation prior to purchasing the ticket or attending the event are ineligible."
- A store's live events today are online and for its community members, so they get no Event rich result, and they are not marked up. schema.org still describes online events (`eventAttendanceMode` `OnlineEventAttendanceMode`, `location` a `VirtualLocation`, [Event](https://schema.org/Event), [VirtualLocation](https://schema.org/VirtualLocation)); this is kept for a later public, in-person event, if the product ever has one.

## The creator's profile

- Google's profile page ([profile page](https://developers.google.com/search/docs/appearance/structured-data/profile-page), last updated 8 September 2026) needs `mainEntity` (a Person or an Organization) with `name`; the page must focus on one person or organization tied to the site. "The main home page of a store" is named as not valid.
- The store's own page is therefore not a ProfilePage. The business card page (639 [GL7](22)) is kept out of search (`noindex`) and is not marked up. A public "about the creator" page, if one is built, can carry it.

## Podcasts

- Google has no podcast structured data: the list of supported features ([search gallery](https://developers.google.com/search/docs/appearance/structured-data/search-gallery), last updated 16 October 2026) has none, and the podcast URLs answer 404.
- schema.org has [PodcastSeries](https://schema.org/PodcastSeries) (with `webFeed`) and [PodcastEpisode](https://schema.org/PodcastEpisode), both in its "new" area. A store's podcast page today is a buyer's private feed, whose address must never be published, so it is not marked up.

## State

Tested in a PR: the course functions and their tests. Nothing is shown to search engines yet; no price, limit, commission, flag or gate changes.
