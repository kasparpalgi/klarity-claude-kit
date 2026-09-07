#!/usr/bin/env bash
# Keep one revision of each headless browser.
#
# Puppeteer and Playwright already share ONE cache per tool across every repo —
# nothing is downloaded per project. What grows is revisions: each tool version pins
# a new browser build and never removes the old one, ~400 MB a bump. This drops every
# revision but the newest in each cache.
#
#   prune-browsers.sh          # show what would go
#   prune-browsers.sh --yes    # actually delete it
#
# Cheaper still: don't download at all. Playwright can drive the Google Chrome you
# already have with `use: { channel: 'chrome' }` in playwright.config.ts.
set -u

DRY=1
[ "${1:-}" = "--yes" ] && DRY=0

# One directory per revision, named so a version sort orders them:
# ~/.cache/puppeteer/chrome/mac_arm-142.0.7444.61, ms-playwright/chromium-1217.
CACHES="$HOME/.cache/puppeteer/chrome
$HOME/.cache/puppeteer/chrome-headless-shell
$HOME/Library/Caches/ms-playwright"

echo "$CACHES" | while read -r cache; do
  [ -d "$cache" ] || continue
  # Playwright keeps ffmpeg beside the browsers; prune each family on its own.
  ls "$cache" | sed -E 's/[-_][0-9].*$//' | sort -u | while read -r family; do
    revs=$(ls "$cache" | grep -E "^${family}[-_][0-9]" | sort -V)
    newest=$(echo "$revs" | tail -1)
    echo "$revs" | grep -vx "$newest" | while read -r old; do
      [ -n "$old" ] || continue
      printf '%s\t%s\n' "$(du -sh "$cache/$old" | cut -f1)" "$cache/$old"
      [ "$DRY" = 0 ] && rm -rf "${cache:?}/$old"
    done
  done
done

[ "$DRY" = 1 ] && printf '\nDry run — re-run with --yes to delete these.\n'
exit 0
