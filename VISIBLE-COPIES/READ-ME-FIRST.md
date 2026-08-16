# The three hidden files

The archive already contains all three at their correct paths:

    .gitignore
    .nojekyll
    .github/workflows/build-apk.yml

**Finder hides them.** Press `Cmd + Shift + .` to show hidden files — they are there.
`ls -la` in Terminal will also show them.

## The part that actually bites

GitHub's web uploader **silently skips dotfiles** when you drag a folder in. No
warning, no error — the push just succeeds without them. The result looks like
nothing happened: Actions never runs (no workflow file) and GitHub Pages serves a
blank app (no `.nojekyll`, so Jekyll strips `js/` and `css/`).

So whichever route you take, create these three ON GitHub rather than relying on
the upload to carry them.

## Route A — git (carries everything, nothing to remember)

    cd plotedge-main
    git init
    git add -A
    git commit -m "PlotEdge"
    git remote add origin https://github.com/<you>/plotedge.git
    git push -u origin main

git does not care that a filename starts with a dot. Nothing is skipped.

## Route B — web upload

Drag the ordinary folders in (`js/`, `css/`, `tests/`, `scripts/`, `signing/`,
`resources/`, and the root files). Then **Add file -> Create new file** three
times and type the full path into the filename box:

| Create at this exact path            | Content                                    |
|--------------------------------------|--------------------------------------------|
| `.gitignore`                         | paste `VISIBLE-COPIES/gitignore.txt`       |
| `.nojekyll`                          | leave empty (a single newline is fine)     |
| `.github/workflows/build-apk.yml`    | paste `VISIBLE-COPIES/github-workflows/build-apk.yml` |

Typing `.github/workflows/build-apk.yml` creates both folders as you type each `/`.

If GitHub greys out the commit button on an empty `.nojekyll`, put one space in it.

## Delete this folder afterwards

`VISIBLE-COPIES/` is a convenience for reading the files without unhiding them.
Nothing references it. Remove it before committing, or add it to `.gitignore`.

## Verify from Terminal, not Finder

    ls -la | grep '^\.'
    ls -la .github/workflows/

You should see `.gitignore`, `.nojekyll`, `.github` — and `build-apk.yml` inside.

If Actions does not run after pushing, the usual cause is the workflow landing at
the wrong path. Check its URL in the repo: it must read
`/blob/main/.github/workflows/build-apk.yml`.

## The keystore

`signing/plotedge-release.keystore` is not hidden, but it is the easiest file to
lose and the most costly. It must upload byte-identical. If it is lost or altered,
every build signs with a new key, Android refuses the update as
INSTALL_FAILED_UPDATE_INCOMPATIBLE, and users must uninstall — which deletes the
data they have captured.
