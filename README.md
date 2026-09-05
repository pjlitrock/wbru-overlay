# Show artwork folders

Each row in the show-schedule sheet's `Artwork_Link` column should be a
path to a folder in *this* repo, relative to the repo root — e.g.:

```
shows/retro-lunch
```

Inside that folder, put **one** image file — `.jpg`, `.jpeg`, or `.png`
— named whatever you want. The overlay asks GitHub what's in the folder
and uses whichever image it finds, so the filename is free to carry real
information: `2024-11-refresh.jpg`, `from-designer-v3.png`, whatever
helps you keep track of it later.

Leave `Artwork_Link` blank to just show the placeholder icon instead of
artwork.

**Keep only one image per folder.** If a folder has more than one
`.jpg`/`.png`/`.jpeg` file, the overlay picks one (alphabetically first)
and logs a warning in the debug panel — it won't cause an error, but
it's ambiguous, so it's best avoided.

## Swapping artwork

Delete the old file and upload the new one (any filename) via GitHub's
web UI, or upload the new file and then delete the old one — either
order works. No need to touch the schedule sheet, HTML, or JS.

Artwork lookups are cached for 5 minutes per folder, so a swap takes up
to 5 minutes to show up on air (or immediately, if the overlay page
happens to reload in OBS in the meantime).

## Adding a new show

1. Create a new folder here, e.g. `shows/morning-drive/`.
2. Add one `.jpg`/`.png`/`.jpeg` file inside it, any filename.
3. In the schedule sheet, set that row's `Artwork_Link` to
   `shows/morning-drive`.

## How this works

The overlay calls GitHub's public API
(`api.github.com/repos/<repo>/contents/<folder>`) to list each folder's
contents on demand, rather than assuming a fixed filename. This only
happens when a show actually comes on screen (not on every poll), so it
stays well within GitHub's rate limits for a single overlay.
