# computer-use-mcp Agent Notes

Scope: `services/computer-use-mcp/**`

## Mission

`computer-use-mcp` is AIRI's deterministic execution substrate.

- AIRI owns planning, chat UX, approval UX, provider integration, and MCP attachment.
- `computer-use-mcp` owns execution primitives, workflow orchestration, terminal/browser/desktop surfaces, trace, audit, and safety checks.
- Treat terminal, browser, editor, and desktop operations as one task system. Do not split them into disconnected demos.

## Reuse Existing UX / Retry / Error Patterns First

This is a hard handoff rule, not a style suggestion.

The [`#1307` review thread](https://github.com/moeru-ai/airi/pull/1307) already hit a real failure mode here: adapter/system work started re-implementing approval popups, error presentation, and helper utilities that the repo already had elsewhere. Do not repeat that.

Before adding any new retry flow, error popup, approval prompt, or helper utility, inspect and prefer the existing repo primitives first:

- Approval / notice UI:
  - Prefer the Electron `notice` window path in `apps/stage-tamagotchi/src/main/windows/notice/` when you need a shell-owned confirm/notice flow.
  - Prefer the shared renderer toaster path in `packages/stage-ui/src/components/scenarios/toasters/` and the existing `vue-sonner` wiring in the app shell when you need in-app error or status notifications.
  - Do **not** default to raw `dialog.showMessageBox` for AIRI / computer-use approval or error UX. This was explicitly called out in review on `apps/stage-tamagotchi/src/main/services/airi/desktop-approval/index.ts` (`discussion_r2925844545`).
- Retry / recovery behavior:
  - Before inventing ad-hoc "try again" loops, read and extend `src/strategy.ts`, `src/transparency.ts`, and `src/workflows/engine.ts`.
  - The service already has advisory kinds, retryability, reroute behavior, and human-readable recovery messaging. Extend that layer instead of creating a parallel retry system inside an adapter.
- Errors / logging / utility helpers:
  - Prefer `errorMessageFrom` from `@moeru/std` for error formatting.
  - Prefer `@guiiai/logg` for logging.
  - Prefer `es-toolkit` for common utility helpers before writing another local helper.
- PR shape / architecture:
  - Keep skeleton/orchestration changes separate from per-adapter additions.
  - Do not mix provider/proxy leftovers, shell UX experiments, and adapter/system work into the same PR just because they are all "computer use related".

## Test Reality First, Do Not Test for the Test

This is another hard handoff rule.

Do not "make tests pass" by locking the implementation to a narrow canned scene and then writing assertions that only prove that canned scene. That is fake confidence. `computer-use-mcp` fails in dirty real environments, not in perfectly staged screenshots.

The anti-pattern is:

- fix the scene in advance
- tailor the runtime to that scene
- write a unit/smoke/E2E that only confirms the tailored path
- then call the feature "validated" while it still explodes in real use

For this repo, the correct testing posture is:

- unit tests prove contract and classification semantics
  - status, failure classification, interruption, reroute, verification outcome, trace shape
- smoke tests prove the lane still works end-to-end under a minimal but real workflow
- E2E tests should prefer realistic, dirty conditions over overly curated demo flows

When adding tests for terminal / browser / desktop / coding work, explicitly ask:

- does this test still pass only because the environment is pre-arranged for success?
- does it cover the kinds of failure that happen in actual runs: lease loss, user preemption, stale foreground app, window mismatch, ambiguous target, missing browser surface, bad terminal output, reroute-required state?
- would this still tell us something useful if the UI/app/window state is not exactly the one we expected?

Do:

- test invariant contracts and failure semantics
- add cases for messy or adversarial state transitions
- keep at least one realistic smoke/E2E path that can fail for the same reasons production usage fails
- treat E2E breakage as product signal, not just flaky test noise

Do not:

- overfit implementation to a frozen fixture scene
- add fake verification just because a test expects "green"
- claim coverage because a deterministic happy-path demo passed once
- replace real failure coverage with screenshot-goldens or hand-wired mocks only

## Current Status Snapshot

Updated for the current terminal-lane-v2 workstream.

This section is intentionally volatile.

- Treat it as a short-lived release snapshot, not a stable contract.
- If a statement here stops describing the current workstream, either rewrite it or move it into a narrower status note.
- Durable boundaries, supported capability shape, entrypoints, and validation expectations should live in the later sections of this file.

The important truth is:

- `exec` is already a real mainline surface.
- `PTY` is no longer just a loose tool set; the workflow engine now has self-acquire support.
- The service-layer terminal E2Es are green.
- The AIRI chat terminal demo is now aligned with terminal lane v2 and no longer pre-creates PTY.
- The desktop shell now distinguishes `pty_session` from `terminal_and_apps`.
- AIRI chat self-acquire is now part of the strict release gate set, so PTY mainline support is no longer intentionally held back.
- Desktop v3 now has a minimal safe-loop surface (`desktop_run_safe_agent_loop`) with observe/decide/act/verify phases, action budget guardrails, lease-loss interruption behavior, and queryable local trace (`desktop_get_safe_loop_trace`).

Do not rely on compressed chat summaries to resume this work. Use this file as the handoff source of truth and update it when terminal-lane behavior changes materially.

## Coding Surface v1.1: What Is Already Landed

`coding surface` is now a real capability layer inside `computer-use-mcp`, but it is **not** a second executor.

### Release posture

The current coding layer should be described honestly as:

- a **minimal but real** coding capability layer
- release-worthy for initial AIRI integration
- intentionally bounded in scope
- expected to keep evolving after launch

Do not describe the current coding layer as a Codex-equivalent system.
The correct framing for release notes and PRs is:

- the coding layer is now usable and testable
- the current release lands the minimum integrated kernel
- deeper planner / diagnosis / benchmark / dirty-world hardening remains follow-up work after launch

The current intended model is:

- coding tools own workspace review, file read/patch, search, context compression, and structured reporting
- terminal lane still owns command execution, PTY/exec surface choice, approval, and audit
- coding workflows must consume terminal state and command results instead of spawning a second command path

### 1. First-class coding tools exist

The current coding tools are:

- `coding_review_workspace`
- `coding_read_file`
- `coding_apply_patch`
- `coding_search_text`
- `coding_search_symbol`
- `coding_find_references`
- `coding_compress_context`
- `coding_report_status`

These are exposed both as MCP tools and as workflow action kinds. Do not fork them into separate "internal" and "external" implementations.

### 2. `workflow_coding_loop` is now search-assisted

`workflow_coding_loop` is no longer hard-wired to an explicit file-only path.

The current behavior is:

- `targetFile` may be omitted
- search hints (`searchQuery` and/or `targetSymbol`) may drive target discovery
- downstream `coding_read_file` / `coding_apply_patch` may consume `filePath: 'auto'`
- auto target resolution succeeds only when the latest search resolves to a single candidate
- ambiguous search results must fail explicitly instead of guessing a target file

This is intentionally still conservative: search helps resolve the target, but the workflow is not yet a fully autonomous multi-candidate planner.

### 3. Search path semantics are fixed to workspace-relative output

Search may run under a scoped `targetPath`, but returned file paths must remain **workspace-relative**.

This is important because:

- `coding_read_file`
- `coding_apply_patch`
- `coding_find_references`

all expect workspace-relative paths. Do not regress this by returning paths relative to a subdirectory search root.

### 4. TS/JS semantic navigation exists, but only as a v1.1 local capability

The current semantic navigation story is:

- `coding_search_text` works as general local text search
- `coding_search_symbol` and `coding_find_references` are local TypeScript-based capabilities
- the implementation is intentionally local to `computer-use-mcp`
- this is **not** a VS Code adapter, not an LSP bridge, and not a plugin platform

If you extend semantic navigation, keep the boundary clear:

- improve the local capability first
- do not drag VS Code, browser, GitHub, or provider-specific integration into this workstream

#### TODO: non-JS/TS semantic navigation roadmap (not in current release scope)

- Python: symbol definition + references via Python AST/indexing, deterministic unsupported fallback while incomplete.
- Rust: item/symbol navigation backed by rust-analyzer-compatible local indexing, deterministic unsupported fallback while incomplete.
- Go: package-aware symbol/references navigation with local module graph, deterministic unsupported fallback while incomplete.
- Other languages: only after Python/Rust/Go parity baseline; keep unsupported contract explicit and route users to `coding_search_text` until semantic support lands.

### 5. Current boundary reminder for coding work

Do:

- strengthen workspace review
- strengthen deterministic self-review/reporting
- improve local search/navigation
- improve patch/edit stability
- improve the coding loop while reusing terminal lane

Do not:

- invent another command executor
- bypass terminal state when summarizing validation
- turn coding surface into a generic plugin or MCP marketplace
- expand this lane into VS Code/browser/native adapter productization

## Desktop Control MVP (Stage 1): Current Product Posture

The desktop control workstream is now framed as a **minimal real companion layer**:

- macOS-first
- preview-first
- bounded by short `act` lease autonomy
- semantic window actions first, coordinate fallback second (and explicit)

The approval boundary for desktop-controller mutations is the `act` lease itself.
Desktop controller mutations under an active `act` lease are executed without a
second per-step approval queue.

### Stable v1 desktop controller tool surface

- `desktop_request_lease`
- `desktop_cancel_lease`
- `desktop_report_user_input`
- `desktop_observe_scene`
- `desktop_observe_pointer`
- `desktop_preview_pointer_move`
- `desktop_preview_layout`
- `desktop_focus_window`
- `desktop_apply_layout`

### v3 safe-loop tools (new)

- `desktop_run_safe_agent_loop`
- `desktop_get_safe_loop_trace`

Current v3 safe-loop posture:

- deterministic plan-in, guarded execution out
- explicit phase trace: observe / decide / act / verify
- action budget and lease-loss interruption are enforced inside the loop
- trace is queryable via MCP without parsing JSONL manually

### Internal-only in v1

- `desktop_move_resize_window`
- `desktop_run_action_plan`

### Semantic action primitives

The desktop controller now targets these core action primitives through the
normal action/policy/audit/transparency stack:

- `focus_window`
- `set_window_bounds`

Current executor posture:

- `macos-local`: semantic window control via AX APIs (`focus_window`, `set_window_bounds`), with constrained fallback for focus.
- `dry-run`: structured no-op simulated success.
- `linux-x11`: explicit unsupported for these two actions in v1.

### Layout semantics

- Presets remain exactly: `coding-dual-pane`, `review-mode`, `agent-watch`.
- With explicit `windowIds`, assignment is caller order -> slot order.
- Without explicit `windowIds`, only positive-score hint matches are assigned.
- Zero-score windows stay unresolved.
- `desktop_apply_layout` fails fast on zero-target preview.

### Boundary reminder

Desktop controller MVP is a separate delivery stream from terminal/coding lane
closure. Do not block desktop-controller hardening on terminal/coding follow-up
items, and do not treat desktop controller completion as proof that
terminal/coding closure is done.

### Deferred stages (explicit)

- Stage 2 (browser semantic adapter): extend the existing browser/CDP/DOM lane;
  reuse bridge/message patterns and semantic browser-control ideas only. Do not
  vendor Python CLI / NL planner / anti-detection / captcha handling.
- Stage 3 (OS input fallback): keep as a separate adapter behind an explicit
  opt-in flag, default OFF, and never the first-choice path.

## Terminal Lane v2: What Is Already Landed

### 1. Terminal surface model exists

Terminal-capable workflow steps now have explicit terminal semantics instead of pure guesswork:

- `mode: 'exec' | 'auto' | 'pty'`
- `interaction: 'one_shot' | 'persistent'`

The main implementation lives in:

- `src/workflows/types.ts`
- `src/workflows/surface-resolver.ts`
- `src/terminal/interactive-patterns.ts`

### 2. Auto surface resolution is fixed to a small rule set

`auto` is intentionally narrow. It only upgrades to PTY when one of these is true:

1. The current `taskId + stepId` already has a bound PTY session.
2. The step explicitly declares `interaction: 'persistent'`.
3. The command matches `KNOWN_INTERACTIVE_COMMAND_PATTERNS`.
4. A failed/timed-out exec attempt surfaces one of `INTERACTIVE_OUTPUT_MARKERS`.

This rule set is covered by:

- `src/workflows/surface-resolver.test.ts`
- `src/terminal/interactive-patterns.test.ts`

### 3. Workflow engine can self-acquire PTY

The engine already contains the v2 shape:

- `AcquirePtyForStep`
- `StepTerminalProgress`
- suspension point `before_pty_acquire`
- PTY step family support:
  - `pty_send_input`
  - `pty_read_screen`
  - `pty_wait_for_output`
  - `pty_destroy_session`

The main implementation lives in:

- `src/workflows/engine.ts`

The intended behavior is:

- workflow resolves the terminal surface
- if PTY is needed, workflow acquires/binds PTY itself
- workflow continues inside the same workflow
- outward terminal reroute is now secondary, not the mainline proof

### 4. Service-layer PTY self-acquire E2E exists and is green

The current real terminal E2E for v2 is:

- `src/bin/e2e-terminal-self-acquire.ts`

This script now proves:

- **no pre-created PTY**
- workflow detects an interactive command
- engine self-acquires PTY
- command executes on PTY
- step succeeds without outward reroute
- run-state / binding / audit stay consistent

It currently uses:

- `workflow_validate_workspace`
- an interactive `checkCommand` of `vim --version`

This is the current service-level proof for terminal lane v2.

### 5. AIRI chat self-acquire demo is now on the v2 path

`src/bin/e2e-airi-chat-terminal-self-acquire.ts` follows the same product story:

- no harness-side `pty_create`
- AIRI calls the real workflow
- the workflow self-acquires PTY for the interactive validation step
- AIRI finishes with a natural-language summary for demo use

The latest successful reports live under:

- `.computer-use-mcp/reports/airi-chat-terminal-self-acquire-*`

The current package commands are:

- `pnpm -F @proj-airi/computer-use-mcp e2e:airi-chat-terminal-self-acquire`
- `pnpm -F @proj-airi/computer-use-mcp demo:terminal-self-acquire`

### 6. Support matrix already reflects the new direction

Relevant entries in `src/support-matrix.ts`:

- `terminal_exec` → `product-supported`
- `terminal_pty` → `product-supported`
- `terminal_exec_to_pty_reroute` → `covered` and explicitly labeled legacy fallback
- `terminal_auto_surface_resolution` → `covered`
- `terminal_pty_self_acquire` → `product-supported`
- `terminal_pty_step_family` → `covered`

The current strict release gates are:

- `pnpm -F @proj-airi/computer-use-mcp e2e:developer-workflow`
- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-exec`
- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-pty`
- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-self-acquire`
- `pnpm -F @proj-airi/computer-use-mcp e2e:airi-chat-terminal-self-acquire`

## What Is Still Not Finished

These are the real gaps. Do not talk yourself into thinking terminal lane is fully shipped before they are closed.

### 1. Desktop approval semantics are improved, but still need one more explicit review

`apps/stage-tamagotchi/src/renderer/App.vue` now distinguishes:

- `terminal_and_apps`
- `pty_session`

and it no longer pretends a PTY approval is the same thing as a generic terminal/app grant.

The current intended behavior is:

- `terminal_exec` / `open_app` / `focus_app` keep the old session-scoped auto-approve behavior
- `pty_create` stores a `pty_session` grant scope
- `pty_create` does **not** auto-approve future PTY creation requests

This is much closer to the product model, but it is still worth reviewing whenever approval UX changes again.

## Open Decisions

These points are intentionally not locked down yet. Treat them as active design
space, not accidental ambiguity.

### Desktop control semantics still under review

- Exact `act` lease lifecycle and reacquire behavior for longer multi-step desktop tasks.
- Which AX failures are allowed to fall back to constrained coordinate behavior, and which must stay explicit unsupported.
- How strict preview/apply consistency must be for layout operations once more window actions are added.
- Which behavior differences between `dry-run` and `macos-local` are intentional contract differences versus temporary gaps.

### macOS control quality follow-up is still open

- Mixed-scale multi-display coordinate normalization is not fully settled yet.
- Permission probing for Accessibility / Screen Recording / Automation should become more explicit before the lane is described as robust.
- Browser-specific semantics, if they become necessary, should still land as a separate lane instead of leaking into the macOS substrate.

## Where To Look First

### Terminal lane

If you are continuing terminal lane work, read these first:

1. `src/workflows/engine.ts`
2. `src/workflows/surface-resolver.ts`
3. `src/terminal/interactive-patterns.ts`
4. `src/bin/e2e-terminal-self-acquire.ts`
5. `src/bin/e2e-airi-chat-terminal-self-acquire.ts`
6. `src/support-matrix.ts`
7. `apps/stage-tamagotchi/src/renderer/App.vue`
8. `apps/stage-tamagotchi/src/renderer/modules/computer-use-approval.ts`

That set is enough to reconstruct the current terminal-lane-v2 state without rereading the entire repo.

### Desktop control

If you are continuing desktop control work, read these first:

1. `src/executors/macos-local.ts`
2. `src/server/action-executor.ts`
3. `src/server/register-tools.ts`
4. `src/policy.ts`
5. `src/desktop/control-arbiter.ts`
6. `src/display/runtime.ts`
7. `src/runtime-probes.ts`
8. `src/preflight.ts`
9. `src/server/register-tools-desktop-control.test.ts`
10. `src/bin/smoke-macos.ts`
11. `src/bin/smoke-macos-safe-loop-v3.ts`

That set is enough to reconstruct the current macOS desktop-control lane without starting from terminal-only entrypoints.

## Validation Commands

Use these as the baseline checks for terminal lane work:

### Service-level terminal lane

- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-exec`
- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-pty`
- `pnpm -F @proj-airi/computer-use-mcp e2e:terminal-self-acquire`
- `pnpm -F @proj-airi/computer-use-mcp e2e:airi-chat-terminal-self-acquire`

### Core test coverage

- `pnpm -F @proj-airi/computer-use-mcp exec vitest run --config ./vitest.config.ts`
- `pnpm -F @proj-airi/computer-use-mcp exec vitest run src/server/register-tools-desktop-control.test.ts --config ./vitest.config.ts`

### Typecheck

- `pnpm -F @proj-airi/computer-use-mcp typecheck`
- `pnpm -F @proj-airi/stage-ui typecheck`

If `pnpm -F @proj-airi/stage-tamagotchi typecheck` behaves oddly in the current environment, run the two underlying commands directly:

- `pnpm -F @proj-airi/stage-tamagotchi run typecheck:node`
- `pnpm -F @proj-airi/stage-tamagotchi run typecheck:web`

## Handoff Rules

If you change terminal lane or desktop-control behavior materially, update this file before stopping.

At minimum, always rewrite these four facts:

1. Is PTY self-acquire the mainline, or does any path still depend on pre-created PTY?
2. Is AIRI chat E2E aligned with the service-level terminal lane, or still on an older path?
3. Is desktop approval using real `pty_session` semantics, or still old `terminal_and_apps` semantics?
4. Which terminal capabilities are `product-supported` vs only `covered` in `src/support-matrix.ts`?

If those four facts are stale, the next agent will lose time re-deriving context from code.

## Scope Reminder

### Allowed now

- Terminal lane closure on the existing exec and PTY model.
- Coding-surface hardening while reusing the existing terminal lane.
- macOS desktop substrate work inside `computer-use-mcp`, including pointer/control primitives and OS-integration quality work.

### Allowed later

- Browser semantic adapter work as a separate lane once desktop substrate scope is stable enough to support it.
- OS input fallback behind an explicit opt-in path, never as the default first-choice surface.

### Out of scope for the current lane

- Provider-specific behavior in AIRI / `packages/stage-ui/**`.
- A second command executor, parallel terminal stack, or hidden bypass around workflow and audit.
- Treating browser, native click/type/press, or VS Code productization as part of the current terminal-lane closure by default.
