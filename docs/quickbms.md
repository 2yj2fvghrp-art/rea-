# Custom archives with QuickBMS

Many games and some applications store their data in custom archives, such as
`.pak`, `.big`, `.arc`, `.tiger` or `.dat` files, that no REA tool parses.
For these, the REA skill teaches your agent to find or write a
[QuickBMS](https://aluigi.altervista.org/quickbms.htm) script. QuickBMS is
aluigi's generic extractor. A `.bms` script describes the archive's header,
file table, names, offsets, sizes and compression. QuickBMS then lists the
entries, extracts and decompresses them, or puts modified files back.

REA does not install, ship or run QuickBMS. Install it yourself if you want
your agent's scripts tested. Without it, the agent still writes the script,
checks the layout against the real file, and gives you the commands to run.

## What the agent does

1. Identifies the file with REA first, in case an REA tool already reads it.
2. Looks for an existing script for the game or format.
3. Otherwise works out the layout from the bytes and, when needed, from the
   loader code in the game executable with REA's native analysis.
4. Writes the script and checks every field it can against the real file.
5. Reports the layout with each field marked observed or inferred, the
   script, the commands to run and the remaining unknowns.

Before suggesting a run of a script it did not write, the agent reads it and
tells you when it starts other programs (`ComType EXECUTE`, `CallDLL`) or
declares encryption.

The instructions live in the skill's
[QuickBMS guide](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/quickbms.md).

## Install QuickBMS

Download it from https://aluigi.altervista.org/quickbms.htm. Builds exist for
Windows, Linux and macOS. QuickBMS is GPL-2.0. The Windows zip contains
`quickbms.exe`, `quickbms_4gb_files.exe` for archives or offsets over 2 GB,
and `quickbms.txt`, the full manual.

## List, extract and repack

```sh
# list entries, write nothing
quickbms -l script.bms archive.pak
# extract and decompress into a new empty folder
quickbms -K script.bms archive.pak out
```

`-K` renames files with duplicate names instead of stopping at a prompt. The
last `coverage` line shows how much of the archive the script read.

Repacking uses the same script. `-w` lets QuickBMS write into the archive, so
work on a backup copy:

```sh
# put modified files from out back into the archive
quickbms -w -r script.bms archive.pak out
```

With `-r`, each modified file must be the same size as the original or
smaller. `-r -r` (reimport2) appends larger files and rewrites their offset
and size fields, which works for many but not all formats. See section 3 of
`quickbms.txt` for the limits.

## Limits

- Encrypted archives are reported, not decrypted. REA does not recover or
  apply keys for protected commercial content.
- Oodle compression (Kraken, Mermaid, Leviathan) needs a library QuickBMS does
  not include.
- Archives that store only name hashes extract with generated names. Real
  names need a community file list.
- The agent cannot test a script unless you run QuickBMS where it can see the
  output.
