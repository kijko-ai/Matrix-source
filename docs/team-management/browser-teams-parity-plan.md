# Browser Teams Parity Plan

## Goal

Explain why the Teams tab is disabled in browser mode today, beyond the visible UI guard, and define a concrete plan to reach functional parity with the Electron Teams experience.

## Executive Summary

The current browser limitation is not a single "Electron-only" check. It is the result of four stacked architectural choices:

1. The standalone/browser runtime was introduced as a Docker/HTTP session-viewer path, not as the primary teams control plane.
2. Electron exposes a large teams surface through preload IPC, but browser mode swaps in `HttpAPIClient`, which intentionally stubs or rejects most team, review, editor, terminal, and cross-team methods.
3. The standalone bootstrap does not construct or inject the core team-management services used by Electron (`TeamDataService`, `TeamProvisioningService`, review services, backup service, terminal service, cross-team service, scheduler integration).
4. The HTTP route layer only covers a narrow runtime-control subset for teams, while the renderer/store expects a much broader API contract.

The practical effect is that browser mode currently has enough infrastructure to serve the app shell, sessions, notifications, and generic SSE events, plus some early team-change groundwork, but not enough backend capability to power the actual Teams UX.

## Evidence-Backed Root Causes

### 1. Browser mode was productized as standalone/session-viewer first

- `README.md` explicitly says the app can be used "just to view past sessions" and frames that as a supported mode.
- `src/main/standalone.ts` logs: "Open in your browser to view Claude Code sessions".
- The standalone support landed as `feat(docker): add standalone mode and Docker support` on 2026-02-16, which strongly suggests the initial standalone priority was deployability and viewing, not full team orchestration.

Interpretation:
The browser runtime was not originally designed as a full replacement for Electron. It was added as an operational access mode.

### 2. The renderer contract was decoupled, but browser implementations were intentionally partial

- `src/renderer/api/index.ts` cleanly abstracts runtime selection: `window.electronAPI` in Electron, `HttpAPIClient` in browser mode.
- `docs/research/electron-decoupling.md` describes this as already-implemented infrastructure for browser mode.
- But `src/renderer/api/httpClient.ts` intentionally returns stubs/errors for most Teams features:
  - `teams.list()` returns `[]`
  - `teams.getData()` throws
  - task creation/update flows throw
  - review APIs throw
  - cross-team APIs throw
  - editor APIs throw
  - terminal APIs throw
  - provisioning progress and tool approval events are no-ops

Interpretation:
The abstraction layer exists, but parity work was not completed. The browser adapter was used as a compatibility shell, not a feature-complete transport.

### 3. The visible Teams banner is only the outermost guard

- `src/renderer/components/team/TeamListView.tsx` renders the message:
  - "Teams is only available in Electron mode"
  - "In browser mode, access to local `~/.claude/teams` directories is not available."

Interpretation:
That message is directionally true, but incomplete. The actual blocker is not merely direct renderer access to `~/.claude/teams`; it is that the browser path does not yet have a complete server-side team control/data plane.

### 4. Standalone boot does not instantiate the services that back Teams in Electron

- Electron `src/main/index.ts` creates and wires:
  - `TeamDataService`
  - `TeamProvisioningService`
  - `TeamBackupService`
  - `CrossTeamService`
  - `PtyTerminalService`
  - review/change services
  - scheduler integration
  - tool approval emitters
  - team-change broadcasting
  - control API base URL resolution
- Standalone `src/main/standalone.ts` only wires:
  - `ServiceContext`
  - `NotificationManager`
  - `HttpServer`
  - `projectScanner`, `sessionParser`, `subagentResolver`, `chunkBuilder`, `dataCache`
  - updater/SSH stubs

Interpretation:
Even if the UI guard were removed, the standalone server does not currently construct the backend services needed to satisfy the renderer's Teams workflows.

### 5. Team HTTP route coverage is intentionally narrow

- `src/main/http/index.ts` only registers team routes if `services.teamProvisioningService` exists.
- `src/main/http/teams.ts` currently exposes only:
  - launch
  - stop
  - runtime state
  - provisioning status
  - alive runtime list

Missing are routes for:

- list teams
- get team data
- logs and stats
- team CRUD
- task CRUD and kanban
- config updates
- member management
- attachments
- task comments
- relationships
- cross-team messaging
- tool approval
- review/diff operations

Interpretation:
The browser/server path currently supports runtime control, not full team management.

### 6. Teams depends on local filesystem mutation and live watchers, not just reads

The team-management docs and implementation describe a hybrid model:

- spawn Claude CLI
- write/read `~/.claude/teams/{team}/...`
- watch inbox/config/task files
- use team-change propagation and process/runtime state

Important evidence:

- `docs/team-management/research-cli-orchestration.md` recommends `CLI spawn + FileWatcher (hybrid)`.
- `docs/team-management/implementation.md` explicitly calls out `httpServer.broadcast('team-change', event)` as "browser mode support", which implies browser support was planned but only at the event-forwarding layer.
- `src/main/index.ts` forwards `team-change` to both Electron renderer and HTTP SSE.
- `src/main/standalone.ts` does not forward `team-change`, provisioning progress, or tool approval events because it does not build the team services that emit them.

Interpretation:
The non-obvious architectural decision was to keep the mutation/control plane local to the Node/Electron side first, then later start exposing read/update signals to HTTP. That second phase is incomplete.

### 7. Several feature areas were explicitly designed as Electron-only vertical slices

Historical docs show feature-by-feature assumptions that browser mode would not need parity:

- `docs/iterations/diff-view/phase-1-read-only-diff.md` defines browser-mode review as stubs.
- `docs/iterations/edit-project/architecture.md` says editor API is available only through Electron IPC and that HTTP endpoints were not required for that feature.

Interpretation:
Teams parity was not blocked by one hard platform limitation. It was the cumulative result of multiple features being implemented under an Electron-first assumption.

## What This Means

The real architectural decision was:

> Use Electron IPC plus local Node services as the full-featured team-management control plane, while browser/standalone mode initially acts as a lighter HTTP-access mode for sessions and selected runtime controls.

So the banner is not the cause. It is a safety guard that prevents the renderer from entering a feature area whose backend contract does not exist yet in standalone mode.

## 1:1 Feature Parity Map

| Feature Area | Electron Today | Browser Today | Root Gap | Required Work |
|---|---|---|---|---|
| Teams list | Full | Guarded / `[]` | No team list HTTP endpoint, no standalone `TeamDataService` | Add standalone team data service + `/api/teams` |
| Team detail | Full | Unavailable | No `getData` HTTP endpoint | Add `/api/teams/:teamName` and dependent reads |
| Draft teams | Full | Unavailable | No draft read/delete HTTP path | Port draft metadata endpoints |
| Create team | Full | Throws | No standalone `prepareProvisioning/createTeam` backend | Instantiate `TeamProvisioningService`, expose endpoints |
| Launch team | Full | Partially wired in backend, blocked in UI | Missing standalone service wiring and progress events | Wire service + progress SSE + remove guard |
| Stop team | Full | Backend route exists, UI blocked | No parity wiring | Reuse runtime route after full UI enablement |
| Alive/runtime badges | Full | Partial | No browser list/detail consumption | Add list/runtime endpoints and SSE updates |
| Claude logs | Full | Stubbed | No HTTP route | Add paginated logs endpoints |
| Kanban read/write | Full | Throws | No team data/task mutation HTTP layer | Port task/kanban routes |
| Task CRUD | Full | Throws | Same | Port task create/update/delete routes |
| Task comments | Full | Throws | Same | Port comment endpoints |
| Task relationships | Full | Throws | Same | Port relationship endpoints |
| Task attachments | Full | Throws | Same | Port attachment upload/download/delete endpoints |
| Member management | Full | Throws | Same | Port add/remove/replace/update role endpoints |
| Member logs/stats | Full | Stubbed | No HTTP route | Port stats/log routes |
| Team config editing | Full | Throws | No HTTP route | Port config update/read routes |
| Cross-team messaging | Full | Throws | No HTTP route + no standalone `CrossTeamService` | Instantiate service + HTTP routes + SSE |
| Review read-only | Full | Throws | No HTTP review routes | Port review read endpoints |
| Review decisions/editable diff | Full | Throws | No HTTP review mutation/watch layer | Port review endpoints + file watch events |
| Tool approval | Full | No-op/throws | No browser event stream or approval routes | SSE + approval endpoints + notification model |
| Team notifications | Full | Partial | Browser has in-app notifications, not team workflow parity | Wire team events/tool approvals into browser |
| Process send / live lead messaging | Full | Throws | No HTTP team process messaging routes | Port process control endpoints |
| Project branch lookup | Full | Returns null | No project/team route | Add backend endpoint |
| Editor overlay from Teams | Full | Throws | Editor still Electron-only | Port ProjectFileService to HTTP |
| Open path / show in folder / open external | Full | Mostly no-op | Utility routes intentionally no-op | Implement server-side shell bridge where acceptable, client fallback where safe |

## Recommended Implementation Strategy

### Principle

Do not "make browser act like Electron" in the renderer.

Instead:

1. Promote standalone/HTTP mode into a first-class local control plane.
2. Make `HttpAPIClient` truly satisfy the same contract as `window.electronAPI` for Teams-related features.
3. Keep native-shell extras behind capability adapters, but preserve functional parity for the Teams workflow itself.

## Phased Plan

### Phase 0: Define the parity contract

Deliverables:

- Freeze a browser-parity checklist derived from `TeamsAPI`, `CrossTeamAPI`, `ReviewAPI`, editor usage inside team views, and team-related utility actions.
- Add a "parity status" test matrix that maps each UI action in Teams to an API method and backend route.

Why first:
Without an explicit contract, browser support will keep regressing into partial vertical slices.

### Phase 1: Rebuild standalone service wiring to match Electron

Implement in `src/main/standalone.ts`:

- instantiate `TeamDataService`
- instantiate `TeamProvisioningService`
- instantiate `TeamBackupService`
- instantiate `CrossTeamService`
- instantiate review-related services (`TeamMemberLogsFinder`, `MemberStatsComputer`, `ChangeExtractorService`, `FileContentResolver`, `ReviewApplierService`, `GitDiffFallback`)
- instantiate `PtyTerminalService` if terminal/process features are required by Teams flows
- wire `team-change`, provisioning-progress, tool-approval, notification, and file-change events into HTTP SSE
- provide `teamProvisioningService` to `HttpServer.start(...)`
- set `controlApiBaseUrlResolver` in standalone just like Electron

Success criteria:

- standalone can enumerate, read, and mutate team state through Node services without any Electron dependency
- runtime events are broadcast over SSE, not only IPC

### Phase 2: Complete the Teams HTTP surface

Extend `src/main/http/teams.ts` so it mirrors the real Teams API instead of just runtime control.

Required route groups:

- list/get team summaries and detail
- create/delete/restore/permanent delete
- draft lifecycle
- provisioning prepare/create/launch/cancel/status
- logs, member logs, member stats
- task CRUD
- kanban writes
- config read/update
- member CRUD
- attachments
- relationships
- deleted task operations
- branch lookup
- lead activity/context/spawn status
- process messaging and liveness
- tool approval response/settings/file preview

Success criteria:

- every `TeamsAPI` method has a real HTTP implementation or an explicit parity exception approved up front

### Phase 3: Add missing browser transports outside `TeamsAPI`

Port adjacent APIs required by the Teams tab:

- `CrossTeamAPI`
- `ReviewAPI`
- `EditorAPI`
- any utility methods used by team components (`openPath`, `showInFolder`, `openExternal`)

Notes:

- review parity requires file-content retrieval, diff computation, decision persistence, and file-watch events
- editor parity requires safe project-root-constrained file operations over HTTP
- browser-specific UI actions can use capability adapters:
  - `openExternal`: `window.open()` in browser
  - `openPath/showInFolder`: server-side shell open when running on the same host, otherwise degrade explicitly

Success criteria:

- `HttpAPIClient` no longer contains team/review/editor/cross-team stubs for features exercised by the Teams tab

### Phase 4: Replace no-op SSE with a full event model

Add SSE channels for:

- provisioning progress
- tool approval events
- external review file changes
- runtime/process state changes
- cross-team message events as needed

Success criteria:

- browser mode receives the same classes of live updates the Electron renderer currently receives over IPC

### Phase 5: Remove UI guards only after backend parity exists

Changes:

- remove the top-level `isElectronMode()` guard in `TeamListView`
- remove or reduce feature-specific guards in team detail, review, editor, and process panels
- convert direct `window.electronAPI.*` usage inside team components to the unified `api` adapter wherever possible

Success criteria:

- browser mode enters the same views, not a separate reduced Teams experience

### Phase 6: Parity verification

Create end-to-end parity tests for these user journeys:

1. list teams and open team detail
2. create team, provision team, launch team
3. send message, receive message, cross-team send
4. create task, move task across kanban, request review
5. inspect logs and member stats
6. open review, accept/reject changes
7. add comments, attachments, relationships
8. respond to tool approval
9. stop/relaunch team
10. use project editor from team detail

Recommended harness:

- one Electron E2E lane
- one standalone/browser E2E lane
- same fixture project + same expected outcomes

## Suggested Delivery Order

1. Phase 1: standalone service parity
2. Phase 2: complete Teams HTTP routes
3. Phase 4: live event parity
4. Phase 3: review/editor/cross-team transport parity
5. Phase 5: remove renderer guards
6. Phase 6: parity test suite

Why this order:

- It establishes the backend truth first.
- It avoids enabling UI paths that still collapse into browser-mode stubs.
- It keeps renderer changes shallow because the API contract becomes truly uniform.

## Risks And Unknowns

### High risk

- Review/editor parity is larger than Teams-list parity because those features were explicitly designed around IPC and direct local file services.
- Tool approval parity needs careful eventing and secure request routing.
- Browser-safe equivalents for shell integrations (`showInFolder`, `openPath`) must be defined explicitly.

### Medium risk

- Team provisioning may rely on environment resolution logic that was written assuming Electron lifecycle/home-path helpers.
- Some direct `window.electronAPI` calls remain in team-related components and will need adapter cleanup.

### Low risk

- Team list/detail/logs/task CRUD are straightforward once the standalone service graph and HTTP routes are in place.

## Recommended Definition Of Done

Declare browser Teams parity complete only when:

- the top-level Teams guard is removed
- no Team-tab user path depends on a browser stub
- standalone instantiates the same core team services as Electron, or functionally equivalent ones
- browser receives live provisioning, runtime, review, and approval events
- the parity E2E suite passes for both Electron and standalone

## Primary Sources

Local code and docs:

- `src/renderer/components/team/TeamListView.tsx`
- `src/renderer/api/httpClient.ts`
- `src/renderer/api/index.ts`
- `src/shared/types/api.ts`
- `src/main/standalone.ts`
- `src/main/http/index.ts`
- `src/main/http/teams.ts`
- `src/main/index.ts`
- `docs/research/electron-decoupling.md`
- `docs/team-management/implementation.md`
- `docs/team-management/research-cli-orchestration.md`
- `docs/iterations/diff-view/phase-1-read-only-diff.md`
- `docs/iterations/edit-project/architecture.md`

Upstream repository evidence:

- Standalone introduction commit: `feat(docker): add standalone mode and Docker support`
  - https://github.com/777genius/claude_agent_teams_ui/commit/ce4116dd85031a89d7dc2e08f98cad5c3399462b
- Runtime control API commit: `feat: implement runtime control API for team management`
  - https://github.com/777genius/claude_agent_teams_ui/commit/4a0b1aa69869e0b9858102725a9a66b77449dc69
- Runtime control API follow-up: `feat: enhance team control API with retry logic and fallback mechanisms`
  - https://github.com/777genius/claude_agent_teams_ui/commit/81ac59e46b826dbc8b0be3a58341302915bd4452
