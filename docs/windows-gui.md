# Windows desktop GUI

REA includes a small Korean-language desktop interface for Windows. It is a
PowerShell WinForms front end to the packaged REA CLI; it adds no Electron
runtime, local web server, or provider. The GUI does not expose a command-line
text box or run an inspected application.

## Install and start

Install a supported Node.js release and REA from PowerShell:

```powershell
npm.cmd install --global rea-agents
rea-gui.cmd
```

The global npm installation adds `rea-gui.cmd` beside `rea.cmd`. The `.cmd`
forms work from PowerShell even when its script policy blocks npm's generated
PowerShell shims. If the command cannot be found, open a new terminal after
installing REA and verify that npm's global binary directory is on `PATH`. The
command remains active until the GUI window closes.

From a source checkout, install and build REA first, then run:

```powershell
npm ci
npm run build:cached
node .\windows-gui\rea-gui.mjs
```

The GUI requires Windows PowerShell, Windows Forms, Node.js, and the REA package
runtime. It uses the CLI from the same package installation as the GUI. The
launcher selects `RemoteSigned` for its child PowerShell process only; it does
not persist a policy change or use `Bypass`. Organization Group Policy takes
precedence. If it blocks the packaged script, ask the administrator to approve
an allowed launch method.

## Included operations

Choose a file or, for the applicable workflows, an application directory:

- `analyze`: the normal REA overview workflow. Native targets use the selected
  or configured provider; JavaScript application directories and ASAR files
  use REA's static analysis route. Ghidra and IDA can be selected explicitly.
- `analyze-javascript-application`: static analysis of an application directory
  or ASAR without starting the application or a native analysis provider.
- `inspect-go-binary`: reads embedded Go build metadata from an ELF, PE, or
  thin Mach-O file.
- `inspect-managed-artifact`: reads .NET PE/CLI identity without loading target
  code.
- `inspect-sqlite-database`: inspects a local SQLite snapshot schema.

The GUI invokes these existing CLI workflows with JSON output and displays
standard output, standard error, and the process exit status. Target analysis
starts only after the user presses **분석 실행**. Native analysis may start the
selected REA provider; the target executable itself is not launched. Provider
availability, format support, and setup requirements remain those of the
underlying REA command.

This MVP accepts local file and directory paths only; it does not accept URLs,
arbitrary REA commands, MCP sessions, or commands that mutate targets, capture
live processes, or install/configure software. SQLite row selection and the
full command catalog remain available through the CLI. Large analysis results
can consume substantial memory in the results window; use the CLI to save and
inspect very large Evidence output. A running operation cannot be cancelled from
the GUI, and the window stays open until it finishes.
