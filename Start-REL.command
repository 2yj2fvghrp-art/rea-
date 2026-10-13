#!/bin/zsh
# REL beginner launcher. Uses only this repository's local lesson.
set -u
cd -- "${0:A:h}" || {
  print -u2 "REL couldn't open its folder. Keep Start-REL.command in the REL checkout."
  exit 1
}
if ! command -v node >/dev/null 2>&1; then
  print ""
  print "REL needs Node.js before it can start."
  print "Nothing was installed or changed."
  print "Read the setup guide: rel/MAC_SETUP.md"
  print "Then open Start-REL.command again."
  if [[ -t 0 ]]; then
    print "Press Enter to close this window."
    read -r ignored || true
  fi
  exit 1
fi
print ""
print "REL / Reverse Engineering Life"
print "-----------------------------------------"
print "Your first mission: search for 'bridge', then press 'Show me how'."
print "No Codex account, API key, or REA build is needed for this first lesson."
print ""
print "Checking this Mac (read-only)..."
node rel.mjs doctor
print ""
print "Opening the visual lab on your own computer."
print "Keep this Terminal window open; press Control+C to stop REL."
exec node rel.mjs lab --open
