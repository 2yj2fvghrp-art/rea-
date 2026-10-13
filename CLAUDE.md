# CLAUDE.md

@AGENTS.md

## Claude Code notes

- Repository skills live in `.agents/skills/`; `.claude/skills/` symlinks them so
  Claude Code loads `rea-tool-design`, `rea-changelog-update` and
  `reverse-engineer-anything`. Edit the `.agents/` copies, never `skills/`
  (generated output).
- A `PostToolUse` hook formats edited files with the pinned `oxfmt`
  (`.claude/hooks/format-edited-file.mjs`). Run `npm ci` first so it resolves.
- Before finishing a change, run the narrowest relevant check:
  `npm run test:local -- PATH...` or `npm run test:focused -- PATH...`, then
  `npm run check:fast` (the same check the pre-push hook runs).
- Personal overrides go in `.claude/settings.local.json` (git-ignored).
