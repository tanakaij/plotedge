# Deploying PlotEdge on GitHub Pages

## Files in this folder
- `index.html` — the whole app (favicon, splash screen, and landing-page logo are all your
  PlotEdge mark, embedded directly as base64 PNG — no separate image files to keep track of)
- `plotedge-sw.js` — service worker (offline support + install prompt)
- `plotedge.manifest.json` — PWA manifest (**must** keep this exact filename — `index.html` and
  `plotedge-sw.js` both reference it by name; its icons are your logo too, same embedded-base64
  approach, plus one extra padded "maskable" version so Android's adaptive-icon shapes don't crop
  it awkwardly)
- `.nojekyll` — tells GitHub Pages to skip Jekyll processing and serve files exactly as they are
- `DEPLOY.md` — this file (safe to delete, doesn't get deployed as part of the app)

There's no `_headers` file anymore — that was Netlify-only and GitHub Pages ignores it silently.
The caching behavior it used to control (never serve a stale `index.html`/service worker after a
new deploy) is now handled entirely in JS (`cache: 'no-store'` in the service worker's fetch
handler, `updateViaCache: 'none'` on registration), so it works the same on GitHub Pages with zero
host-specific config.

## Steps

1. **Create a repo** on GitHub (public — GitHub Pages is free for public repos; private repos need
   a paid plan for Pages).
2. **Push these files to the repo root** (or to a `/docs` folder — either works, see step 4).
   ```bash
   git init
   git add .
   git commit -m "PlotEdge"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
3. **Settings → Pages** in your repo.
4. Under **Source**, choose **Deploy from a branch**, pick `main` and either `/ (root)` or `/docs`
   depending on where you put the files, then **Save**.
5. GitHub gives you a URL like `https://<your-username>.github.io/<your-repo>/` — it can take a
   minute or two to go live after the first push.

## Updating the app after it's deployed

Whenever you get new files from Claude (like this batch), you're just replacing what's already in
the repo — GitHub Pages picks up the change automatically within a minute or two of the push. Two
ways to do it, no coding required for either:

**A. GitHub's website (easiest for a single file like `index.html`)**
1. Open your repo on github.com, click into the file (e.g. `index.html`).
2. Click the pencil/edit icon, select all, delete, paste in the new version, and click
   **Commit changes** at the bottom.
3. Repeat for any other changed file (`plotedge-sw.js`, `plotedge.manifest.json`).

**B. Command line (better once you're updating multiple files at once)**
```bash
cd your-repo-folder
# copy the new files in, overwriting the old ones, then:
git add .
git commit -m "Update PlotEdge"
git push
```
Either way, reload the deployed URL after a minute — the service worker's network-first fetch
(see `plotedge-sw.js`) means you'll see the update on the very next load, not a stale cached copy.

## One thing to know: subpath vs. root

If your repo is named e.g. `plotedge` and you deploy to the default
`https://<username>.github.io/plotedge/` URL, the app is served from a **subpath**, not the domain
root. This project already uses relative paths everywhere (`plotedge-sw.js`, not `/plotedge-sw.js`,
same for the manifest and its `start_url`), so it should work correctly under a subpath with no
changes needed. If you later add a **custom domain** (Settings → Pages → Custom domain), the app
would then be served from the root and still work unchanged either way.

## Testing it worked

- Open the deployed URL, confirm the map/app loads.
- Change something trivial, push again, reload the page within a minute — it should show the
  change immediately (not a stale cached version). That's the behavior the old `_headers` file was
  responsible for on Netlify; it's now baked into the app itself.
- On Android Chrome or desktop Chrome/Edge, you should see the "Install PlotEdge" banner appear.
- **First visit only:** you should see your logo bloom in on the splash screen with a soft chime,
  then fade into the landing page. Reload the page and it won't play again — that's intentional
  (see the `plotedge_visited` flag in `index.html`). To re-test it, clear the site's storage in
  devtools (Application → Storage → Clear site data) or open in a private/incognito window.


---

## What to upload (the app is no longer one file)

PlotEdge used to be a single `index.html`. It is now a shell plus two asset folders, and **all of
it has to go up together** — uploading `index.html` alone gives a blank, unstyled page that looks
exactly like data loss to a crew in the field.

```
index.html
css/            all 5 files
js/             all 22 files
plotedge-sw.js
plotedge.manifest.json
```

Paths are relative throughout, so this still works from a domain root or a GitHub Pages subpath.

**Bump `SW_VERSION` in `plotedge-sw.js` whenever the list of css/ or js/ files changes.** The
service worker caches every one of them by name; a stale shell cache would serve the old list and
silently skip a new file. `npm test` fails if the cache list and the tags in `index.html` disagree.
