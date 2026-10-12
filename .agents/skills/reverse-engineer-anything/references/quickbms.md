# Custom archives and QuickBMS scripts

Use this guide when the target keeps its data in a custom archive or package
that no REA tool parses, such as a game `.pak`, `.big`, `.arc`, `.tiger` or
`.dat`, and the user wants to list, extract or understand it. QuickBMS is
aluigi's generic extractor (GPL-2.0, https://aluigi.altervista.org/quickbms.htm).
A `.bms` script describes the header, file table, names, offsets, sizes and
compression. QuickBMS uses it to list the entries, extract and decompress
them, or put modified files back into the archive. REA does not ship or run
QuickBMS. The user installs it and decides where it runs.

## Workflow

1. Identify the file with REA first. `open_binary` or `inspect_artifact`
   classifies archives REA already reads, such as ZIP. Use REA's own reader
   when one exists.
2. Look for an existing script for the game or format.
3. Otherwise work out the layout from the bytes and, when needed, from the
   loader code in the target executable.
4. Write the script.
5. Run it, or hand it to the user to run, then check its output against the
   archive's own table.
6. Report the script, the layout and what is still unknown.

## Treat every script as code

A `.bms` file looks like a data description, but QuickBMS runs it as a
program. `ComType EXECUTE` and the `-S` option start external programs, and
`CallDLL` loads native code. A script from a forum or repository can therefore
do anything the user's account can do. Follow the user's rules for where
downloaded tools run, and run against copies of the target, not the installed
files. Reading a script as text is safe anywhere.

Read any script you did not write before it runs. Scripts are short text
files, so read the whole file, or search it with whatever text search the
environment offers. BMS commands are case-insensitive. Look for these:

- `ComType EXECUTE` or `CallDLL`: name the program or DLL the script needs and
  tell the user it will be run. Do not run the script without their explicit
  approval.
- `Include`: the script pulls in another script. Read that one too.
- `Encryption`, `FileXOR`, `FileCrypt`: the archive is encrypted or
  obfuscated. Report the declared algorithm. Recovering or applying keys for
  protected commercial content is out of scope.
- `Put*` on the input file or another real file: the script writes into it.
  `Put*` on a `MEMORY_FILE` or an array only builds data in memory.

Leave out the switches that widen what a script can do: `-C` (CallDLL without
asking), `-n` (network), `-p` (processes), `-A`, `-g`, `-m` (devices), `-Y`
(answer yes to every prompt), `-S` (run a command per file) and `-9` (disable
the safe memory allocator). `-w` lets QuickBMS write into the archive. Use it
only to repack, on a backup copy, when the user asked for that.

## Find an existing script

Search before writing: aluigi's script list on the QuickBMS page,
github.com/DKDave/Scripts (`QuickBMS` folder), and the ZenHAX and XeNTaX forum
archives. Link to a script and credit its author. Copy it into the user's
project only if its licence allows that. Many pre-2008 XeNTaX `.bms` files are
compiled MultiEx Commander scripts full of binary bytes, which QuickBMS cannot
run.

## Work out the layout

Most archives are a header (magic, version, entry count), a table of entries
(name or name hash, offset, size, compressed size, flags) and a data area.
Read the header and the first entries from the real file and confirm each
field before writing the script. A wrong guess usually still produces files,
just wrong ones, so these checks are what separate a script that works from
one that only runs:

- Entry count times entry size ends exactly where the next structure starts:
  the name table or the first data offset.
- Every offset plus stored size stays inside the file, or inside the part file
  it points to.
- The stored sizes add up close to the size of the data area.
- A compressed entry starts with its codec's magic (`78 9C` zlib,
  `28 B5 2F FD` zstd) or inflates to exactly its declared size. Two-byte
  magics also match random bytes, so trust them only at a known offset.

Patterns that recur:

- **Sector offsets.** The stored value is in blocks of 0x800 or similar.
  Multiply: `math OFFSET * 0x800`.
- **Packed offsets.** Spare low bits hold a part number or flags, and the data
  starts at the offset with those bits cleared. Split them with `math`:
  `math PART & 0xF` and `math OFFSET & 0xFFFFF800`.
- **Relative offsets.** Offsets count from the end of the table or from a base
  field in the header. Add the base.
- **Hashes instead of names.** Many archives store only a 32-bit hash per
  entry. Name the output after the hash, `string NAME p "%08x.dat" HASH`, or
  use `log "" OFFSET SIZE` and let QuickBMS guess the extension. Real names
  need a hash list from the community.
- **Split archives.** The table lives in one file and data in numbered parts.
  Open each part with `open FDSE "name.001" 1` and pass its file number to
  `log` or `clog`.
- **Per-entry compression.** A flag field picks stored, zlib, raw deflate,
  zstd or another codec. Set `comtype` inside the loop for each entry.

When the bytes are not enough, find the loader in the target executable with
REA. Search strings for the archive extension or magic, open the function that
reads the header with `analyze_function`, and follow the reads of the count,
offset and size fields. Keep observed fields apart from inferred meanings.
Name a field you cannot explain `DUMMY` and list it as an unknown.

## Write the script

Fields are little-endian 32-bit unless `endian big` is set. Names are
optional. Offset and size are the minimum. This example reads a table at 0x5C
with 32-byte entries and a compressed size of 0 for stored entries:

```
idstring "LOD\0"
get TYPE long
get FILES long
goto 0x5c
for i = 0 < FILES
    getdstring NAME 16
    get OFFSET long
    get SIZE long
    get DUMMY long
    get ZSIZE long
    if ZSIZE == 0
        log NAME OFFSET SIZE
    else
        clog NAME OFFSET ZSIZE SIZE
    endif
next i
```

| Command                                    | Use                                   |
| ------------------------------------------ | ------------------------------------- |
| `IDString "MAGIC"`                         | Stop unless the magic matches.        |
| `Endian big`                               | Switch byte order.                    |
| `Get VAR byte\|short\|long\|longlong`      | Read a number.                        |
| `GetDString VAR LEN`, `Get VAR string`     | Read a fixed or zero-terminated name. |
| `GoTo OFF`, `SavePos VAR`, `Padding 0x800` | Move, remember or align the position. |
| `For i = 0 < N` ... `Next i`               | Loop over entries.                    |
| `Math VAR * 0x800`, `Math VAR & 0x7FF`     | Arithmetic and bit masks.             |
| `String NAME p "%08x.dat" HASH`            | Build a name from a number.           |
| `Open FDSE "file.001" 1`                   | Open a part file as file number 1.    |
| `Log NAME OFF SIZE [FILENUM]`              | Extract a stored entry.               |
| `CLog NAME OFF ZSIZE SIZE [FILENUM]`       | Extract a compressed entry.           |
| `ComType zlib\|deflate\|zstd\|lz4\|lzma`   | Choose the `CLog` codec.              |
| `If VAR == VALUE` ... `Elif` ... `EndIf`   | Branch on a flag.                     |

`zlib` expects the two-byte zlib header and `deflate` expects raw deflate.
The full language is section 4 of `quickbms.txt` in the QuickBMS download.

## Run, check and report

1. List with `quickbms -l script.bms archive`. It prints offset, size and
   name for each entry and writes no files.
2. Extract with `quickbms -K script.bms archive OUTPUT` into a new empty
   folder. `-K` renames duplicate names instead of stopping at a prompt.
3. Compare the extracted file count and total bytes with the sums from the
   archive's own table. The last `coverage` line shows how much of the archive
   the script read. Low coverage means skipped entries, a wrong table size, or
   data the table does not point to. Check which before calling the script
   wrong: some formats keep blocks that only other entries reference.
4. Report the script, a table of the layout with each field marked observed
   or inferred, the count and size check, the coverage, and every unknown.

If QuickBMS cannot run in the current environment, still write the script.
State that it is untested and give the user the exact list and extract
commands to run.

To put modified files back, the same script works in reimport mode:
`quickbms -w -r script.bms archive OUTPUT`. Each file must be the same size as
the original or smaller. `-r -r` appends larger files and rewrites their
offset and size fields, but fails when offsets need more than one `math` step
or the table is compressed. Work on a backup copy, because `-w` writes into
the archive.

## Limits

- `quickbms.exe` uses 32-bit numbers. `longlong` reads 8 bytes but keeps only
  the low 32 bits. Use `quickbms_4gb_files.exe` for archives or offsets over
  2 GB.
- Oodle (Kraken, Mermaid, Leviathan) needs a library QuickBMS does not
  include. Report Oodle use and do not fetch the library for the user.
