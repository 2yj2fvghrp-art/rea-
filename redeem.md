# Redeem log

This file records a local docs fix. Nothing was pushed.

## What changed

Edited `website/README.md` in the local preview section. Added an Apple Silicon Cairo note. The old text covered Debian only. The new text covers the ARM build, the Intel shadow path, and the exact backup and link commands.

## Why the change was needed

The preview failed at the sharing image step on an ARM Mac. The system had Intel Cairo 1.18.4 in `/usr/local/lib` and ARM Cairo 1.18.6 in `/opt/homebrew/lib`. Python found the Intel file first and stopped with an architecture error. The old Intel brew cannot unlink itself on ARM. `DYLD_LIBRARY_PATH` stays ignored on current macOS.

## Commands used to diagnose

Checked `arch`, checked the Python build, and listed both lib paths. Confirmed `/opt/homebrew/lib/libcairo.dylib` reports `arm64`. Confirmed `/usr/local/lib/libcairo*` pointed at the Intel Cellar.

## Fix applied locally

Moved Intel links to `~/cairo-intel-backup/`. Linked the ARM files into `/usr/local/lib/`. Ran the preview with `arch -arm64 python3 scripts/website.py serve`.

## Verification

Ran `python3 scripts/website.py check` after the edit. No code was committed and no branch was pushed. Push waits for your approval.
