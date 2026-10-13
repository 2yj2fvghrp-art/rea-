# Local research case UI

From this checkout, run:

```sh
npm run research:ui
```

A package containing this feature also exposes `rea-research-ui`.

Open the printed `http://127.0.0.1:<port>/` address. The server binds only to
loopback and serves four static UI files. It does not fetch a program URL,
receive form data, store a case, run REA, or submit a report. Close the server
with Ctrl-C.

Enter the program URL and exact policy text, add each in-scope identifier and
its policy reference, then enter the rules, artifact path and digest. Download
the policy snapshot, case JSON, and readable Markdown to a private case
directory outside this repository. The browser keeps edits only in memory;
download the JSON before closing the tab, then use **Load case JSON** to resume.
The case JSON includes the policy text, paths, and finding notes you enter.

The page shows a starting REA command for the artifact type. Run it separately
in your terminal and add its Evidence IDs and source locations to candidate
findings. Review the current program policy and participation state before any
live interaction. A case file does not establish authorization.

See [the full guide](../docs/authorized-security-research.md) and
[case template](../docs/authorized-security-research-case.md). To check the
static server and export logic, run `npm run verify:research-ui`.
