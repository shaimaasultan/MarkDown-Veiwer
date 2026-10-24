# Python editor and controlled runner: implementation plan

## 1. Purpose

Add a Python editing workflow to Markdown Folder Viewer while preserving the viewer's existing rule that viewed source is displayed as text and is never executed automatically. The viewer will provide editing, local suggestions, on-demand formatting/checking, policy review, and an explicit Run action. A fixed external command runner will start Python outside the WebView2 page in a separate Command Prompt window.

This plan describes a useful, layered control system. It does **not** claim that static inspection proves arbitrary Python safe. Python runs with the Windows permissions of the identity that starts it unless a separate Windows security boundary is added and verified.

## 2. Decisions already made

- Add a dedicated Python editor mode for `.py` files; keep the existing safe source display behavior for other code files.
- Include editor-only syntax highlighting, indentation, bracket matching, and basic suggestions. Suggestions use Python keywords and names found in the current file; they do not require a continuously running language server.
- Provide formatting and code checks only on demand. The application will not automatically install tools or download dependencies.
- Do not execute the document to produce suggestions, formatting, diagnostics, or policy findings.
- The viewer does not host or execute the Python document. Clicking Run invokes one known external `.cmd` runner, which opens a separate Command Prompt and starts the app-managed Python runtime.
- Use one stable, app-managed Python executable rather than whichever Python happens to be on `PATH`. Add a Windows Firewall outbound block rule for that executable, with status visible in setup and run review.
- Create a unique run workspace/environment for each execution. Show active and completed runs in the viewer and let the user delete a run environment after it finishes.
- Use a YAML policy to describe allowed and forbidden capabilities. The runner validates the policy before creating a run. A policy item is called an enforced restriction only when an operating-system control actually enforces it; source-only checks are labeled as checks.
- When review finds a risk or uncertainty, show **Code needs review**, explain the hazard, and identify the relevant source location(s). If the configured policy forbids a detected action, do not launch the script unless the policy is deliberately changed.

## 3. Fit with the current application

The current app is a Windows C# WebView2 application with its viewer assets under `app/source/`. `viewer.js` already has document state, a Markdown source editor, save/export helpers, private app requests, and status badges. The Python editor should be a distinct mode so that it does not change Markdown editing or the safe code-view behavior.

The C# host currently handles the private WebView2 request surface and the app's folder-scoped file access. The external runner should be added under the managed application tools area (the repository currently uses `app/Setup Scripts/` for setup scripts; use a clearly named `app/tools/` for runtime tools if approved during implementation). Keep the runner, policy, runtime, and user-run workspaces clearly separated. The viewer must not accept a runner path, Python path, or shell command from document contents.

## 4. Security vocabulary shown in the product

Use these terms consistently:

- **Code needs review**: the analyzer found a policy-relevant pattern or could not resolve code needed to evaluate the policy.
- **Detected in source**: an AST/source inspection found a particular import, call, or construction at a location. This describes source evidence, not necessarily runtime behavior.
- **Not resolved statically**: a dependency or target is dynamic, computed, native, or otherwise beyond the analyzer's supported model.
- **OS-enforced**: a specific Windows control is enabled and verified for this run, such as an outbound firewall rule for the managed interpreter.
- **Not enforced**: the policy asks for a restriction that this configuration cannot guarantee. Strict mode must stop instead of quietly treating it as enforced.
- **Review passed**: supported source checks found no policy violation. Never label this “safe,” “sandboxed,” or “guaranteed safe.”

## 5. Target layout

Illustrative layout; finalize installation paths and ACL ownership during implementation:

```text
app/
  source/
    viewer.html
    viewer.js
    ...
  tools/
    run-python.cmd                 # fixed entry point; no document-supplied commands
    python-policy.yaml             # managed policy, not project code
    policy-schema.json             # accepted YAML keys and value constraints
    python-runtime/                # app-managed, versioned interpreter and stdlib
    analyzers/                      # trusted parse/check helpers, if needed
    formatters/                     # optional pre-provisioned local formatter
  user-data/
    python-runs/<run-id>/           # per-run source copy, package set and logs
    python-results/<run-id>/        # explicitly approved output location
```

The installed runtime and policy should be in a directory the run process cannot modify. The script must not be able to alter the runner, runtime, policy, firewall-rule state, or another run's files. If the chosen installation model cannot protect those files from the executing identity, document that limit and do not present the policy as tamper-proof.

## 6. YAML policy design

Keep the first schema small, versioned, explicit, and strict. Unknown keys, invalid types, duplicate keys, malformed YAML, and unsupported policy versions fail closed. Do not allow YAML to contain shell fragments, arbitrary executable paths, environment-variable expansions, Python snippets, or raw command-line templates.

Illustrative starting point (final fields require implementation review):

```yaml
schema_version: 1
mode: review-and-enforce

runtime:
  managed_runtime_only: true
  require_runtime_integrity_check: true
  require_firewall_outbound_block: true

imports:
  allowed_standard_library:
    - argparse
    - csv
    - datetime
    - json
    - math
    - pathlib
    - re
    - statistics
  allowed_third_party: []
  unknown_imports: block
  native_extensions: block

capabilities:
  network: deny
  subprocess: deny
  dynamic_code: review
  file_read_scope: selected-file-and-approved-roots
  file_write_scope: run-workspace-and-approved-results

limits:
  timeout_seconds: 120
  memory_mb: 1024
  max_child_processes: 1

review:
  unresolved_dynamic_behavior: block
  require_confirmation_each_run: true
```

The import allowlist is an analyzer/environment policy, not a substitute for OS permissions. For an import or capability that cannot be enforced, the UI must say so. Keep defaults conservative; changing a denied capability should be a deliberate policy edit with an explanation of the impact. A document may never edit or override the policy.

### 6.1 Policy enforcement map

| Policy item | Planned mechanism | What it does not guarantee |
|---|---|---|
| Outbound network denied | Windows Defender Firewall outbound block rule scoped to the stable managed Python executable path; verify rule existence/effect before strict-mode launch | Does not stop a script from launching another network-capable executable if subprocess creation is allowed or escapes process controls |
| Subprocess denied | Native runner starts the interpreter suspended, assigns it to a Windows Job Object before resuming it, disallows breakaway, and applies a one-active-process limit; verify behavior on supported Windows versions | Must be tested against alternate process-creation paths and host job nesting; do not claim universal denial without evidence |
| Timeout / process cleanup | Job Object time/process limits and kill-on-job-close, supervised by the external runner | A stuck or escaped process outside the job needs separate detection and handling |
| File read/write roots | Launch under a restricted Windows identity with ACLs that grant only the required input/runtime and run/output folders; preferably stage a read-only source copy | A YAML path list alone cannot stop filesystem access; a normal user token keeps that user's ordinary permissions |
| Approved Python imports | AST import/dependency inventory, isolated runtime search paths, and only pre-provisioned approved packages | Cannot prove an import target if it is computed dynamically; native code can access OS capabilities directly |
| Dynamic code | AST findings for `exec`, `eval`, compile-to-execute patterns, dynamic imports and reflective loading; block or require policy review | Static checks cannot prove that all dynamic execution forms are found |
| Runtime/policy integrity | Protected install location, version/hash checks, and read-only access to the run process; show version and status | Hashes only help if the expected hash/policy is itself protected |

If creating a restricted Windows identity or applying folder ACLs requires setup privileges, do that only through an explicit, documented setup step. Do not silently elevate the viewer or runner. If required enforcement is unavailable, mark it unavailable and block runs in strict mode.

## 7. Detailed review report

The analyzer should produce findings that are useful for a human review, not just a red badge. Each finding should include:

1. Severity and policy result: `blocked`, `needs review`, or `informational`.
2. Category: network, subprocess/process launch, filesystem, dynamic execution/import, dependency, native extension, persistence/system change, credential-sensitive API, resource exhaustion, or unresolved behavior.
3. Exact source path, one-based line and column, and a bounded source excerpt. Clicking a location opens the Python editor at that line and highlights it.
4. The syntax/API identified, such as `subprocess.run`, `socket.create_connection`, `Path.write_text`, `open`, `importlib.import_module`, `eval`, or `ctypes`.
5. The apparent operation and the concrete hazard in plain language. For example: “This call starts another program. That program may have its own file and network access.”
6. Evidence type: direct call, alias-resolved call, locally traced helper, import/dependency, or unresolved/dynamic.
7. A trace when the supported analyzer can establish one: `main()` at line N → `run_task()` at line M → `subprocess.run()` at line K. Mark the trace as static and partial.
8. Argument analysis: show a literal executable/path/URL when statically visible; otherwise say “argument is computed at runtime.” Do not evaluate the expression to obtain a value.
9. Relevant configured rule and enforcement state: “blocked by policy check,” “firewall rule verified,” “not OS-enforced,” or “unknown; blocked in strict mode.”
10. Remediation/review action: remove/change the operation, approve the capability in the protected policy, or choose a compatible restricted mode.

Example:

> **Code needs review — subprocess launch (blocked)**  
> `app.py`, line 42, column 5: `subprocess.run(command, check=True)`  
> This call can start another program. The command is computed at runtime, so the program name cannot be identified from source. Policy `capabilities.subprocess: deny` blocks this run.  
> Call trace: `main()` (line 18) → `export_report()` (line 39) → `subprocess.run()` (line 42). Static trace; indirect or dynamic calls may not be visible.

### 7.1 Detection categories and boundaries

- **Imports/dependencies:** record every ordinary `import` and `from ... import ...`; resolve aliases, relative imports and statically identifiable local calls. Report versions, package roots and hashes when available. Do not import a module to inspect it. Recursively inspect source files for approved pure-Python dependencies, within depth/file/size limits.
- **Network:** identify common APIs (`socket`, `urllib`, `http.client`, `requests`, `httpx`, `ftplib`, `smtplib`, WebSocket libraries) and trace local helper calls where feasible. Treat custom wrappers, native extensions, and dynamic loading as unresolved. The firewall rule is the OS control for the managed interpreter.
- **Process launch:** identify `subprocess`, `os.system`, `os.popen`, `os.spawn*`, `os.exec*`, `pty`, `multiprocessing`, common WMI/COM use, and direct Win32 launch APIs when imports/aliases are visible. Explain that string matching alone is not comprehensive. The Job Object is the planned process-tree control; test its coverage and report limitations.
- **Filesystem:** report reads, writes, deletes, renames, directory traversal, temporary-file creation and access to sensitive-looking locations when paths are visible. Resolve constant paths relative to the script/work directory. If paths are constructed from input or variables, report them as computed. Enforce scope with Windows identity/ACL controls, not just AST policy.
- **Dynamic behavior:** flag `eval`, `exec`, `compile` used to produce executable code, `__import__`, `importlib`, `sys.meta_path`, reflective attribute access, `ctypes`, `cffi`, `marshal`, dynamic plugin loading, and obfuscation indicators. Be precise: some occurrences may be benign; explain the operation and policy reason rather than declaring malicious intent.
- **Persistence/system changes:** identify common registry writes, service/task creation, startup locations, shell/profile changes, privilege operations, and destructive file calls when visible. These findings are review indicators; arbitrary Windows API access is not exhaustively discoverable from source.
- **Resource use:** detect obvious unbounded loops, large allocations, recursive expansion, and multiprocessing patterns as heuristics. Apply timeout/memory/process limits where Windows mechanisms support them; label static resource findings as heuristics.
- **Unknown native code:** block unapproved `.pyd`/DLL extensions in strict mode. Native extensions can make OS calls outside Python-level analysis.

### 7.2 Analysis reliability rules

- Parse with a Python AST parser without executing the document. The trusted analyzer itself may run as an app-managed tool; it must receive only source and return structured findings.
- Never import the target file or its dependencies to “see what happens.”
- Do not flatten/in-line imported modules. It can change module semantics, fails on native modules and cycles, and cannot resolve runtime-dependent imports/calls.
- The analyzer may build an approximate dependency and call graph. It must mark edges as direct, locally resolved, inferred, or unresolved.
- If dynamic imports, `exec`/`eval`, native extensions, custom import hooks, or unsupported syntax make a required policy decision uncertain, strict mode blocks with the unresolved locations. A user may change the policy only through the explicit policy workflow.
- Avoid claiming a complete call graph. Python resolves names and executes some operations at runtime; the set of code paths may depend on inputs and environment.
- Bound analyzer work (source size, dependency count/depth, AST node count, analysis time) so malformed or huge projects cannot stall the UI.

## 8. User experience

### 8.1 Python editor

- Show a Python-specific editor only for `.py` files. Other source files continue using their current safe text/source view.
- Use a locally bundled editor component (no CDN) with Python highlighting, line numbers, indentation, bracket matching, selection, find, and visible line/column.
- Provide basic completion from Python keywords, snippets, and names/import aliases found in the open source. State that these are file-local suggestions, not type-aware predictions.
- Add explicit **Format**, **Check**, **Review policy**, **Save**, and **Run** actions. Formatter/checker actions run only when clicked and do not execute the document.
- Preserve detected encoding, BOM, and line endings on save where supported. If a safe round-trip cannot be guaranteed, explain and offer Save As with a known encoding. Keep the original file unchanged until explicit save.
- Warn about unsaved edits before closing, changing files, or running. Offer Save / Run without saving only if the runner uses the current editor buffer through an explicitly staged temporary copy / Cancel; make which version is executed unambiguous.

### 8.2 Pre-run review and confirmation

The confirmation screen should show:

- source file path, file hash/size and whether it is saved;
- managed runtime version/path and integrity status;
- run ID and per-run workspace;
- working directory and script arguments (each displayed as a separate argument, not a concatenated shell command);
- enabled policy, effective restrictions, and whether each is OS-enforced;
- policy findings with severity, source locations, call traces, hazard summaries, and unresolved items;
- formatter/check state separately from execution approval;
- timeout/resource limits, package set, output folder, firewall-rule status, and cleanup choice.

Require confirmation for each run. If policy blocks a finding, do not present a casual “Run anyway” shortcut. Changing a denied capability should open the policy editor, explain the wider effect, save the policy deliberately, and rerun analysis. If an enforcement prerequisite is missing, strict mode refuses to launch.

### 8.3 Results and run management

- Open one clearly titled Command Prompt window per run, with run ID in its title and an initial summary of the exact interpreter, script, working directory and arguments.
- Stream standard output/error; retain the exit code, start/end time, timeout or cancellation reason, and runner log. Do not treat console text as trusted HTML in the viewer.
- The viewer has a run list with `Preparing`, `Review blocked`, `Running`, `Completed`, `Failed`, `Timed out`, and `Cancelled` states.
- For each run, provide **Delete environment**, **Keep environment**, and (if useful) **Open output folder**. State what is deleted: copied source, per-run package files, caches and temp files. Never delete the user's original script or an output folder without explicit selection.
- Make stale-run cleanup visible on next launch; do not silently retain large run folders indefinitely.

## 9. Execution protocol and runner boundary

1. Viewer saves or stages the selected buffer through a narrow app-owned operation; validates file size/path; computes a content hash; creates an opaque run ID.
2. Viewer sends only structured fields to a fixed C# runner API or fixed `.cmd` entry point: run ID, staged script path, argument array, work directory ID and policy version/hash. No arbitrary command strings or executable paths.
3. The runner validates that all paths are under approved roots and rejects traversal, UNC/network shares, reparse-point escapes, unexpected file extensions and malformed arguments according to policy.
4. The runner reads and validates YAML against a strict schema, snapshots its effective policy, verifies runtime integrity and firewall state, and starts the trusted static analyzer.
5. The analyzer emits structured JSON (bounded output, no HTML); the runner validates findings and policy decisions. It never executes/imports the selected source during analysis.
6. The viewer presents findings. If review is required, user reviews the exact code locations; if blocked, fix the code or deliberately alter the policy as described above.
7. On confirmed run, runner prepares a new per-run environment from the app-managed runtime and only approved local packages. It must not read requirements from the script and automatically `pip install` them. No network-based package installation.
8. The native runner launches the exact managed `python.exe` with a fixed, structured argument list, controlled environment variables and working directory. It sets process/job/firewall controls before user code starts where technically possible.
9. Runner supervises process tree, timeout and resource limits; streams logs to the console/viewer; records exit status; and applies the user's retention choice.

The `.cmd` file is a small, audited entry point, not the enforcement engine for OS-level controls. Avoid relying on batch quoting as a security boundary. Use a C# native launcher for process creation, Job Object assignment, path validation, output capture and cleanup; `.cmd` can open a titled console and delegate structured arguments to it. This preserves the requested external Command Prompt experience while keeping enforcement code maintainable.

## 10. Staged implementation

### Stage 0 — Threat model and prerequisites

- Document that scripts are arbitrary user code and may be malicious or simply buggy.
- Decide supported Windows versions, installation location, managed Python distribution/version, architecture, runtime update method, and whether first release requires a dedicated restricted Windows identity.
- Map every YAML control to an enforcement mechanism and test procedure. Mark any source-only rule explicitly.
- Design a protected policy/runtime location, firewall rule naming/versioning, policy editing workflow, and uninstall cleanup behavior.
- Define strict-mode behavior when Firewall, process limits, ACLs, runtime validation, or policy validation cannot be verified.

**Exit criteria:** reviewed threat model, policy schema draft, setup prerequisites and no overclaimed guarantees.

### Stage 1 — Python editor, no execution

- Add a Python editor mode with local syntax highlighting, indentation, bracket matching, line/column display, basic suggestions and unsaved state.
- Preserve encoding/BOM/line endings where possible; implement explicit Save and Save As safely through the app host.
- Do not add Run yet. No code is passed to Python during editing.
- Add manual-open and large-file safeguards; keep HTML preview/source rendering protections intact.

**Exit criteria:** edit/save/reopen round trip for common encodings and line endings; source remains inert; Markdown editor behavior unchanged.

### Stage 2 — On-demand formatting and diagnostics

- Add Format and Check buttons using only pre-provisioned, version-pinned local tools.
- Run a formatter only on click; show diff/proposed result before apply; preserve encoding/line endings and require explicit save.
- Syntax-check without executing target code. Clearly label syntax errors versus style warnings.
- No automatic package installation; present setup instructions if optional formatter is missing.

**Exit criteria:** no document code runs during format/check; formatter changes are reviewable and reversible.

### Stage 3 — Policy schema and static source review

- Implement strict YAML schema/version validation and policy UI.
- Build the non-executing AST analyzer and source-location mapping.
- Add findings for imports/dependencies, subprocess, network, filesystem, dynamic code/imports, native extensions, persistence/system changes and resource heuristics.
- Add alias/local-helper tracing, argument literal analysis, dependency inventory, unresolved flags, caps and timeout.
- Add **Code needs review** report with clickable line/column, excerpt, reason, potential hazard, trace and enforcement status.
- Add regression fixtures for benign examples, direct and alias calls, nested helpers, computed names, dynamic imports, `exec`, syntax errors, native imports, huge inputs and encoding edge cases.

**Exit criteria:** deterministic structured reports; no source execution/import; uncertain policy-relevant cases fail closed in strict mode; UI uses “review passed” rather than “safe.”

### Stage 4 — Managed runtime and run-environment lifecycle

- Bundle or explicitly provision a supported app-managed runtime; verify version, architecture, file inventory and expected hashes.
- Ensure the global/system Python and `PATH` are not used to launch the script.
- Create a unique run ID and isolated per-run package/work directory from the managed runtime. Support standard-library-only scripts first.
- Add offline, approved dependency staging only after package provenance and install-time code execution risks are addressed; do not run setup/build hooks from arbitrary packages.
- Implement keep/delete/cleanup actions and recovery from interrupted runs.

**Exit criteria:** every run uses the app-managed interpreter and distinct run workspace; package selection is explicit and offline; cleanup cannot reach user source or unrelated paths.

### Stage 5 — External runner and process supervision

- Add fixed runner invocation with structured arguments and strict path validation.
- Open an external, per-run Command Prompt with run ID; invoke only the managed interpreter.
- Implement process creation with no shell interpolation of document text, controlled environment, exact working directory and argument array.
- Apply Job Object process/time/memory controls and verify child-process behavior; ensure cleanup kills the managed process tree where supported.
- Stream stdout/stderr and capture exit code, timeout/cancel and runner diagnostics; test console-close and viewer-close behavior.

**Exit criteria:** viewer never starts target Python itself; a run only starts after user confirmation and policy approval; process supervision and cleanup work on supported systems.

### Stage 6 — Firewall and OS permission enforcement

- Add/check a Windows Firewall outbound block rule for the stable managed Python executable. Use an explicit setup permission step if elevation is required; do not silently change firewall state.
- At runtime verify that the rule is present, enabled, scoped to the correct runtime path and active profile. If network denial is required but cannot be verified, block strict-mode launch.
- Test direct Python socket attempts and explain that launching a separate executable is outside the executable-specific firewall rule.
- Implement restricted-account/ACL controls for the configured input, runtime, workspace and results roots if file access restrictions are part of strict mode.
- Verify controls against alternate APIs, helper programs, symlinks/reparse points, path changes, policy tampering and cleanup edge cases. Document residual gaps.

**Exit criteria:** UI reports actual control state, not requested state; no control is called enforced without a test; unavailable enforcement blocks strict mode.

### Stage 7 — Integration, usability and release readiness

- Add Run confirmation, Code needs review flow, policy editor, run history/status, result display and environment cleanup UI.
- Update README, security checklist, setup documentation, privacy notes and security model with exact guarantees/limitations.
- Build/package the app and verify signed/bundled assets, managed runtime hashes, runner paths and installation ACLs.
- Conduct manual security review and negative testing before enabling Run in a release build.

**Exit criteria:** documented security claims match demonstrated enforcement; no automatic downloads or hidden execution; setup/uninstall and user-data retention are clear.

## 11. Verification matrix

| Area | Required scenarios |
|---|---|
| Inert editing | Open `.py`, type code, accept completion, format/check; confirm target script has not started and no network/download occurred |
| File preservation | UTF-8, UTF-8 BOM, UTF-16 if supported, CRLF/LF, non-ASCII, very long line, Save As, cancel, read-only file, external modification conflict |
| Analyzer accuracy | Direct/aliased calls, imported wrappers, local helper chains, relative imports, comments/strings that resemble calls, computed arguments, dynamic imports, `exec`/`eval`, native modules, unsupported syntax |
| Review UX | Finding links to exact line/column; excerpt matches source; traces labeled partial; unknown behavior is stated; policy-blocked Run remains blocked |
| Policy handling | Valid/invalid YAML, duplicate/unknown keys, bad version, altered policy, denied/allowed values, protected policy location, stale analyzer output |
| Runner boundary | Malicious-looking filename/arguments, quotes/unicode/long paths, traversal and UNC paths, injected shell characters, missing runtime, runtime hash mismatch, wrong executable path |
| Network | Firewall rule missing/disabled/wrong binary/profile, direct socket from managed Python, attempt to invoke a helper executable, IPv4/IPv6, rule removal/update |
| Process limits | Normal child process, nested child, multiprocessing, timeout, cancellation, console closed, viewer closed, runner crash, pre-existing host Job Object |
| File boundaries | Read/write inside allowed roots, attempts outside, symlink/reparse point, UNC path, inherited handles, output cleanup, original file untouched |
| Per-run lifecycle | Two concurrent runs, unique IDs/windows/folders, retain, delete, app restart with stale run, disk-full and partial setup failure |
| Dependencies | Approved stdlib, missing formatter, approved offline package, unapproved dependency, native extension, package install/build hook never runs implicitly |

## 12. Open implementation choices

These should be decided in Stage 0 before coding the runner:

1. Which Windows editions/versions must support Run, and should strict execution be unavailable if a restricted Windows identity cannot be configured?
2. Which managed Python version/architecture will be provisioned, and how will runtime updates and hashes be delivered without automatic downloads?
3. Should initial Run support only standard-library scripts, or a curated offline package bundle?
4. Which file roots may the run identity read/write, and where will results be saved?
5. Should runs be deleted automatically by default after exit, or retained until the user deletes them?
6. Should the policy allow user edits through the viewer, and which changes require setup/admin approval?

## 13. Non-goals for the first release

- Full IntelliSense/type inference equivalent to an always-running Python language server.
- Perfect call-graph reconstruction or proof that arbitrary Python is harmless.
- Running HTML, Markdown, or any viewed document as a side effect of opening it.
- Downloading Python, pip packages, formatters, analyzers, or dependencies automatically.
- Describing a venv, per-run folder, YAML allowlist, source scan, audit hook, or executable firewall rule as a complete sandbox.
- Allowing the document or its metadata to select commands, executable paths, firewall changes, or policy edits.

## 14. Release principle

Show the user what the checker found, where it found it, what the code may do, which Windows control enforces each restriction, and what remains unknown. If a requested strict restriction is not verifiably enforced, do not run the script under a misleading “restricted” status.
