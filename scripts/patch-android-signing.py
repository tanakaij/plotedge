#!/usr/bin/env python3
"""
Give every build the SAME signing identity and an INCREASING versionCode.

═══════════════════════════════════════════════════════════════════════════════
WHY THIS EXISTS — this is the "I have to cancel the first install, then go for
update the second time" bug, and it is also what wiped the survey data.

`android/` is not committed; `npx cap add android` regenerates it on every run,
and `./gradlew assembleDebug` signs with Gradle's *auto-generated* debug key at
~/.android/debug.keystore. A GitHub Actions runner is a fresh VM, so that file
never exists and Gradle quietly creates a BRAND NEW RANDOM KEY on every single
build. Every APK therefore carries a different signature.

Android will not update an installed app whose signature does not match the
incoming one (INSTALL_FAILED_UPDATE_INCOMPATIBLE). The package installer's only
route forward is uninstall-then-install — which is exactly the cancel/retry
dance, and which deletes /data/data/com.plotedge.app. The WebView's localStorage
lives in there. That is where the projects, the feature types and every app
setting went: not a crash inside the app, but the installer removing the app
directory because the new APK could not be recognised as the same app.

On top of that, `cap add android` always writes versionCode 1, so even with
matching signatures Android sees every build as a same-version reinstall.

This script fixes both: a persistent keystore (checked in under signing/, or
supplied via the ANDROID_KEYSTORE_B64 secret) applied to the build type that is
actually shipped, and a versionCode derived from the CI run number.

Safe to run more than once; it is a no-op if already applied.
═══════════════════════════════════════════════════════════════════════════════
"""

import os
import pathlib
import re
import sys

GRADLE = pathlib.Path("android/app/build.gradle")
MARKER = "// PLOTEDGE-SIGNING"


def resolve_keystore() -> pathlib.Path:
    """The keystore the APK will be signed with, in priority order."""
    # 1. CI secret, already decoded to this path by the workflow.
    env = os.environ.get("PLOTEDGE_KEYSTORE_PATH", "").strip()
    if env and pathlib.Path(env).exists():
        return pathlib.Path(env).resolve()
    # 2. The copy committed to the repo. A self-signed sideload key, not a Play
    #    Store upload key — its only job is to stay byte-identical between
    #    builds so Android keeps recognising the app as the same app.
    local = pathlib.Path("signing/plotedge-release.keystore")
    if local.exists():
        return local.resolve()
    return None


# ══ WHY THERE IS A FLOOR ══
# versionCode came straight from GITHUB_RUN_NUMBER, which counts up reliably — but only WITHIN
# ONE REPO. Deleting the repo and creating a fresh one resets that counter to 1, while the phone
# still has the old APK installed at whatever number the old repo reached. Android requires a
# strictly GREATER versionCode to update in place, so the new build is a downgrade and the
# install fails with INSTALL_FAILED_VERSION_DOWNGRADE — surfaced to the user as a bare
# "App not installed".
#
# The tempting fix at that point is to uninstall first, and that deletes /data/data/com.plotedge.app
# — every project, feature type and capture on the device. The whole point of the stable keystore
# above is to make uninstalling unnecessary, and a reset run counter quietly undoes it.
#
# So the run number is treated as an OFFSET above a floor rather than as the version itself.
# 1000 is chosen to sit clearly above any run count a repo of this age could have reached, and
# it only ever needs raising if a future repo is deleted again after 1000+ builds.
VERSION_CODE_FLOOR = 1000


def version_code() -> int:
    """
    Monotonic across builds AND across a repo being recreated.

    PLOTEDGE_VERSION_CODE is an absolute override (used to jump the floor if an older install
    somehow sits above it). GITHUB_RUN_NUMBER is added to the floor, so a fresh repo's run 1
    produces 1001 rather than 1.
    """
    raw = os.environ.get("PLOTEDGE_VERSION_CODE", "").strip()
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    run = os.environ.get("GITHUB_RUN_NUMBER", "").strip()
    if run.isdigit() and int(run) > 0:
        return VERSION_CODE_FLOOR + int(run)
    return VERSION_CODE_FLOOR + 1


def version_name(code: int) -> str:
    # Shown to humans, so it tracks the build number rather than the floored internal code:
    # code 1007 reads as 1.0.7, not 1.0.1007.
    override = os.environ.get("PLOTEDGE_VERSION_NAME", "").strip()
    if override:
        return override
    build = code - VERSION_CODE_FLOOR if code > VERSION_CODE_FLOOR else code
    return f"1.0.{build}"


def patch_gradle(keystore: pathlib.Path, code: int, name: str) -> int:
    if not GRADLE.exists():
        print(f"ERROR: {GRADLE} not found — run this after `npx cap add android`.")
        return 1

    text = GRADLE.read_text(encoding="utf-8")
    if MARKER in text:
        print("  already patched; skipping")
        return 0

    # NOTE: os.environ.get(key, default) only falls back to `default` when the
    # key is ABSENT. GitHub Actions always sets these env vars from `env:`,
    # even when the underlying secret does not exist in the repo — it just
    # sets them to "". So an unset secret used to produce store_pass = "",
    # not "plotedge", and Gradle would fail with "keystore password was
    # incorrect" even though the committed keystore's real password is fine.
    # `or` treats "" the same as unset, which is what we actually want here.
    store_pass = os.environ.get("PLOTEDGE_KEYSTORE_PASSWORD") or "plotedge"
    key_alias = os.environ.get("PLOTEDGE_KEY_ALIAS") or "plotedge"
    key_pass = os.environ.get("PLOTEDGE_KEY_PASSWORD") or store_pass

    # ── versionCode / versionName ──
    # These live in defaultConfig. Rewriting rather than appending, because
    # Gradle takes the last assignment and a stale `versionCode 1` sitting above
    # ours would be harmless but confusing to read back.
    before = text
    text = re.sub(r"versionCode\s+\d+", f"versionCode {code}", text, count=1)
    text = re.sub(r'versionName\s+"[^"]*"', f'versionName "{name}"', text, count=1)
    if text == before:
        print("  WARNING: versionCode/versionName not found in defaultConfig")

    signing_block = f"""
    {MARKER} — stable identity so Android accepts an in-place update.
    signingConfigs {{
        plotedge {{
            storeFile file('{keystore.as_posix()}')
            storePassword '{store_pass}'
            keyAlias '{key_alias}'
            keyPassword '{key_pass}'
        }}
    }}
"""

    # Insert signingConfigs immediately inside `android {`.
    m = re.search(r"^android\s*\{", text, flags=re.MULTILINE)
    if not m:
        print("ERROR: no `android {` block in build.gradle")
        return 1
    text = text[: m.end()] + signing_block + text[m.end():]

    # ── apply it to the build type that actually ships ──
    # The workflow publishes assembleDebug, so the debug build type is the one
    # that must carry the stable key. Release is set too, so switching the
    # workflow to assembleRelease later needs no second change here.
    def attach(block_name: str, body: str) -> str:
        pattern = re.compile(r"(buildTypes\s*\{)", re.MULTILINE)
        if not pattern.search(body):
            # No buildTypes block at all — add one.
            m2 = re.search(r"^android\s*\{", body, flags=re.MULTILINE)
            body = body[: m2.end()] + "\n    buildTypes {\n    }\n" + body[m2.end():]
        # Does the named build type already exist inside buildTypes?
        bt = re.search(r"buildTypes\s*\{", body)
        idx = bt.end()
        existing = re.compile(r"\b" + block_name + r"\s*\{")
        tail = body[idx:]
        em = existing.search(tail)
        if em:
            insert_at = idx + em.end()
            return (
                body[:insert_at]
                + f"\n            signingConfig signingConfigs.plotedge {MARKER}"
                + body[insert_at:]
            )
        return (
            body[:idx]
            + f"\n        {block_name} {{\n            signingConfig signingConfigs.plotedge {MARKER}\n        }}"
            + body[idx:]
        )

    text = attach("debug", text)
    text = attach("release", text)

    GRADLE.write_text(text, encoding="utf-8")
    print(f"  signed with: {keystore}")
    print(f"  versionCode: {code}   versionName: {name}")
    return 0


def main() -> int:
    keystore = resolve_keystore()
    if keystore is None:
        print(
            "ERROR: no keystore found.\n"
            "  Expected signing/plotedge-release.keystore in the repo, or the\n"
            "  ANDROID_KEYSTORE_B64 secret decoded to PLOTEDGE_KEYSTORE_PATH.\n"
            "  Refusing to build: an APK signed with a throwaway debug key cannot\n"
            "  update the installed app and forces an uninstall, which deletes all\n"
            "  captured survey data."
        )
        return 1
    code = version_code()
    return patch_gradle(keystore, code, version_name(code))


if __name__ == "__main__":
    sys.exit(main())
