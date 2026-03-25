/**
 * HTTP-based implementation of ElectronAPI for browser mode.
 *
 * Replaces Electron IPC with fetch() for request/response and
 * EventSource (SSE) for real-time events. Allows the renderer
 * to run in a regular browser connected to an HTTP server.
 */

import type {
  AddMemberRequest,
  AddTaskCommentRequest,
  AgentChangeSet,
  AppConfig,
  AttachmentFileData,
  ApplyReviewRequest,
  ApplyReviewResult,
  ClaudeMdFileInfo,
  ClaudeRootFolderSelection,
  ClaudeRootInfo,
  CliInstallerAPI,
  ConfigAPI,
  ContextInfo,
  ConversationGroup,
  CreateTaskRequest,
  CrossTeamAPI,
  ElectronAPI,
  FileChangeEvent,
  FileChangeWithContent,
  ConflictCheckResult,
  GlobalTask,
  HunkDecision,
  HttpServerAPI,
  HttpServerStatus,
  KanbanColumnId,
  ChangeStats,
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberFullStats,
  MemberLogSummary,
  MemberSpawnStatusesSnapshot,
  NotificationsAPI,
  NotificationTrigger,
  PaginatedSessionsResult,
  Project,
  RepositoryGroup,
  Schedule,
  ScheduleRun,
  SearchSessionsResult,
  SendMessageRequest,
  SendMessageResult,
  Session,
  SessionAPI,
  SessionDetail,
  SessionMetrics,
  SessionsByIdsOptions,
  SessionsPaginationOptions,
  SnippetDiff,
  SshAPI,
  SshConfigHostEntry,
  SshConnectionConfig,
  SshConnectionStatus,
  SshLastConnection,
  SubagentDetail,
  TeamChangeEvent,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamData,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamsAPI,
  TeamUpdateConfigRequest,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TaskAttachmentMeta,
  TaskComment,
  TriggerTestResult,
  UpdateKanbanPatch,
  ReplaceMembersRequest,
  ToolApprovalEvent,
  ToolApprovalFileContent,
  ToolApprovalSettings,
  TeamCreateConfigRequest,
  TeamMessageNotificationData,
  UpdaterAPI,
  RejectResult,
  WaterfallData,
  WslClaudeRootCandidate,
  TaskChangeSetV2,
} from '@shared/types';
import type { AgentConfig } from '@shared/types/api';
import type { EditorAPI, EditorFileChangeEvent, ProjectAPI } from '@shared/types/editor';
import type { TerminalAPI } from '@shared/types/terminal';
import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

export class HttpAPIClient implements ElectronAPI {
  private baseUrl: string;
  private eventSource: EventSource | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event callbacks have varying signatures
  private eventListeners = new Map<string, Set<(...args: any[]) => void>>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.initEventSource();
  }

  // ---------------------------------------------------------------------------
  // SSE event infrastructure
  // ---------------------------------------------------------------------------

  private initEventSource(): void {
    if (typeof EventSource === 'undefined') {
      console.warn('[HttpAPIClient] EventSource not available; realtime updates disabled');
      this.eventSource = null;
      return;
    }
    this.eventSource = new EventSource(`${this.baseUrl}/api/events`);
    this.eventSource.onopen = () => console.log('[HttpAPIClient] SSE connected');
    this.eventSource.onerror = () => {
      // Auto-reconnect is built into EventSource
      console.warn('[HttpAPIClient] SSE connection error, will reconnect...');
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event callbacks have varying signatures
  private addEventListener(channel: string, callback: (...args: any[]) => void): () => void {
    if (!this.eventListeners.has(channel)) {
      this.eventListeners.set(channel, new Set());
      // Register SSE listener for this channel once
      this.eventSource?.addEventListener(channel, ((event: MessageEvent) => {
        const data: unknown = JSON.parse(event.data as string);
        const listeners = this.eventListeners.get(channel);
        listeners?.forEach((cb) => cb(data));
      }) as EventListener);
    }
    this.eventListeners.get(channel)!.add(callback);

    return () => {
      this.eventListeners.get(channel)?.delete(callback);
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  /**
   * JSON reviver that converts ISO 8601 date strings back to Date objects.
   * Electron IPC preserves Date instances via structured clone, but HTTP JSON
   * serialization turns them into strings. This restores them so that
   * `.getTime()` and other Date methods work in the renderer.
   */
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern with bounded quantifier; no backtracking risk
  private static readonly ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z?$/;

  private static reviveDates(_key: string, value: unknown): unknown {
    if (typeof value === 'string' && HttpAPIClient.ISO_DATE_RE.test(value)) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) return d;
    }
    return value;
  }

  private async parseJson<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      try {
        const parsed = JSON.parse(text) as { error?: string };
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      } catch {
        throw new Error(text || `HTTP ${res.status}`);
      }
    }
    if (!text) return undefined as T;
    return JSON.parse(text, (key, value) => HttpAPIClient.reviveDates(key, value)) as T;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const init: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`${this.baseUrl}${path}`, init);
      return this.parseJson<T>(res);
    } finally {
      clearTimeout(timeout);
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.request('GET', path);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request('POST', path, body);
  }

  private put<T>(path: string, body?: unknown): Promise<T> {
    return this.request('PUT', path, body);
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request('PATCH', path, body);
  }

  private del<T>(path: string, body?: unknown): Promise<T> {
    return this.request('DELETE', path, body);
  }

  private buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      query.set(key, String(value));
    }
    const qs = query.toString();
    return qs ? `?${qs}` : '';
  }

  // ---------------------------------------------------------------------------
  // Core session/project APIs
  // ---------------------------------------------------------------------------

  getAppVersion = (): Promise<string> => this.get<string>('/api/version');

  getProjects = (): Promise<Project[]> => this.get<Project[]>('/api/projects');

  getSessions = (projectId: string): Promise<Session[]> =>
    this.get<Session[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`);

  getSessionsPaginated = (
    projectId: string,
    cursor: string | null,
    limit?: number,
    options?: SessionsPaginationOptions
  ): Promise<PaginatedSessionsResult> => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', String(limit));
    if (options?.includeTotalCount === false) params.set('includeTotalCount', 'false');
    if (options?.prefilterAll === false) params.set('prefilterAll', 'false');
    if (options?.metadataLevel) params.set('metadataLevel', options.metadataLevel);
    const qs = params.toString();
    const encodedId = encodeURIComponent(projectId);
    const path = `/api/projects/${encodedId}/sessions-paginated`;
    return this.get<PaginatedSessionsResult>(qs ? `${path}?${qs}` : path);
  };

  searchSessions = (
    projectId: string,
    query: string,
    maxResults?: number
  ): Promise<SearchSessionsResult> => {
    const params = new URLSearchParams({ q: query });
    if (maxResults) params.set('maxResults', String(maxResults));
    return this.get<SearchSessionsResult>(
      `/api/projects/${encodeURIComponent(projectId)}/search?${params}`
    );
  };

  searchAllProjects = (query: string, maxResults?: number): Promise<SearchSessionsResult> => {
    const params = new URLSearchParams({ q: query });
    if (maxResults) params.set('maxResults', String(maxResults));
    return this.get<SearchSessionsResult>(`/api/search?${params}`);
  };

  getSessionDetail = (
    projectId: string,
    sessionId: string,
    options?: { bypassCache?: boolean }
  ): Promise<SessionDetail | null> => {
    const params = new URLSearchParams();
    if (options?.bypassCache) params.set('bypassCache', 'true');
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    return this.get<SessionDetail | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}${suffix}`
    );
  };

  getSessionMetrics = (projectId: string, sessionId: string): Promise<SessionMetrics | null> =>
    this.get<SessionMetrics | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/metrics`
    );

  getWaterfallData = (projectId: string, sessionId: string): Promise<WaterfallData | null> =>
    this.get<WaterfallData | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/waterfall`
    );

  getSubagentDetail = (
    projectId: string,
    sessionId: string,
    subagentId: string,
    options?: { bypassCache?: boolean }
  ): Promise<SubagentDetail | null> => {
    const params = new URLSearchParams();
    if (options?.bypassCache) params.set('bypassCache', 'true');
    const qs = params.toString();
    const suffix = qs ? `?${qs}` : '';
    return this.get<SubagentDetail | null>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(subagentId)}${suffix}`
    );
  };

  getSessionGroups = (projectId: string, sessionId: string): Promise<ConversationGroup[]> =>
    this.get<ConversationGroup[]>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/groups`
    );

  getSessionsByIds = (
    projectId: string,
    sessionIds: string[],
    options?: SessionsByIdsOptions
  ): Promise<Session[]> =>
    this.post<Session[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions-by-ids`, {
      sessionIds,
      metadataLevel: options?.metadataLevel,
    });

  // ---------------------------------------------------------------------------
  // Repository grouping
  // ---------------------------------------------------------------------------

  getRepositoryGroups = (): Promise<RepositoryGroup[]> =>
    this.get<RepositoryGroup[]>('/api/repository-groups');

  getWorktreeSessions = (worktreeId: string): Promise<Session[]> =>
    this.get<Session[]>(`/api/worktrees/${encodeURIComponent(worktreeId)}/sessions`);

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  validatePath = (
    relativePath: string,
    projectPath: string
  ): Promise<{ exists: boolean; isDirectory?: boolean }> =>
    this.post<{ exists: boolean; isDirectory?: boolean }>('/api/validate/path', {
      relativePath,
      projectPath,
    });

  validateMentions = (
    mentions: { type: 'path'; value: string }[],
    projectPath: string
  ): Promise<Record<string, boolean>> =>
    this.post<Record<string, boolean>>('/api/validate/mentions', { mentions, projectPath });

  // ---------------------------------------------------------------------------
  // CLAUDE.md reading
  // ---------------------------------------------------------------------------

  readClaudeMdFiles = (projectRoot: string): Promise<Record<string, ClaudeMdFileInfo>> =>
    this.post<Record<string, ClaudeMdFileInfo>>('/api/read-claude-md', { projectRoot });

  readDirectoryClaudeMd = (dirPath: string): Promise<ClaudeMdFileInfo> =>
    this.post<ClaudeMdFileInfo>('/api/read-directory-claude-md', { dirPath });

  readMentionedFile = (
    absolutePath: string,
    projectRoot: string,
    maxTokens?: number
  ): Promise<ClaudeMdFileInfo | null> =>
    this.post<ClaudeMdFileInfo | null>('/api/read-mentioned-file', {
      absolutePath,
      projectRoot,
      maxTokens,
    });

  // ---------------------------------------------------------------------------
  // Agent config reading
  // ---------------------------------------------------------------------------

  readAgentConfigs = (projectRoot: string): Promise<Record<string, AgentConfig>> =>
    this.post<Record<string, AgentConfig>>('/api/read-agent-configs', { projectRoot });

  // ---------------------------------------------------------------------------
  // Notifications (nested API)
  // ---------------------------------------------------------------------------

  notifications: NotificationsAPI = {
    get: (options) =>
      this.get(
        `/api/notifications?${new URLSearchParams(
          options
            ? {
                limit: String(options.limit ?? 20),
                offset: String(options.offset ?? 0),
              }
            : {}
        )}`
      ),
    markRead: (id) => this.post(`/api/notifications/${encodeURIComponent(id)}/read`),
    markAllRead: () => this.post('/api/notifications/read-all'),
    delete: (id) => this.del(`/api/notifications/${encodeURIComponent(id)}`),
    clear: () => this.del('/api/notifications'),
    getUnreadCount: () => this.get('/api/notifications/unread-count'),
    testNotification: async () => ({
      success: false,
      error: 'Test notifications require Electron (not available in browser mode)',
    }),
    // IPC signature: (event: unknown, error: unknown) => void
    onNew: (callback) =>
      this.addEventListener('notification:new', (data: unknown) => callback(null, data)),
    // IPC signature: (event: unknown, payload: { total; unreadCount }) => void
    onUpdated: (callback) =>
      this.addEventListener('notification:updated', (data: unknown) =>
        callback(null, data as { total: number; unreadCount: number })
      ),
    // IPC signature: (event: unknown, data: unknown) => void
    onClicked: (callback) =>
      this.addEventListener('notification:clicked', (data: unknown) => callback(null, data)),
  };

  // ---------------------------------------------------------------------------
  // Config (nested API)
  // ---------------------------------------------------------------------------

  config: ConfigAPI = {
    get: async (): Promise<AppConfig> => {
      const result = await this.get<{ success: boolean; data?: AppConfig; error?: string }>(
        '/api/config'
      );
      if (!result.success) throw new Error(result.error ?? 'Failed to get config');
      return result.data!;
    },
    update: async (section: string, data: object): Promise<AppConfig> => {
      const result = await this.post<{ success: boolean; data?: AppConfig; error?: string }>(
        '/api/config/update',
        { section, data }
      );
      if (!result.success) throw new Error(result.error ?? 'Failed to update config');
      return result.data!;
    },
    addIgnoreRegex: async (pattern: string): Promise<AppConfig> => {
      await this.post('/api/config/ignore-regex', { pattern });
      return this.config.get();
    },
    removeIgnoreRegex: async (pattern: string): Promise<AppConfig> => {
      await this.del('/api/config/ignore-regex', { pattern });
      return this.config.get();
    },
    addIgnoreRepository: async (repositoryId: string): Promise<AppConfig> => {
      await this.post('/api/config/ignore-repository', { repositoryId });
      return this.config.get();
    },
    removeIgnoreRepository: async (repositoryId: string): Promise<AppConfig> => {
      await this.del('/api/config/ignore-repository', { repositoryId });
      return this.config.get();
    },
    snooze: async (minutes: number): Promise<AppConfig> => {
      await this.post('/api/config/snooze', { minutes });
      return this.config.get();
    },
    clearSnooze: async (): Promise<AppConfig> => {
      await this.post('/api/config/clear-snooze');
      return this.config.get();
    },
    addTrigger: async (trigger): Promise<AppConfig> => {
      await this.post('/api/config/triggers', trigger);
      return this.config.get();
    },
    updateTrigger: async (triggerId: string, updates): Promise<AppConfig> => {
      await this.put(`/api/config/triggers/${encodeURIComponent(triggerId)}`, updates);
      return this.config.get();
    },
    removeTrigger: async (triggerId: string): Promise<AppConfig> => {
      await this.del(`/api/config/triggers/${encodeURIComponent(triggerId)}`);
      return this.config.get();
    },
    getTriggers: async (): Promise<NotificationTrigger[]> => {
      const result = await this.get<{ success: boolean; data?: NotificationTrigger[] }>(
        '/api/config/triggers'
      );
      return result.data ?? [];
    },
    testTrigger: async (trigger: NotificationTrigger): Promise<TriggerTestResult> => {
      const result = await this.post<{
        success: boolean;
        data?: TriggerTestResult;
        error?: string;
      }>(`/api/config/triggers/${encodeURIComponent(trigger.id)}/test`, trigger);
      if (!result.success) throw new Error(result.error ?? 'Failed to test trigger');
      return result.data!;
    },
    selectFolders: async (): Promise<string[]> => {
      console.warn('[HttpAPIClient] selectFolders is not available in browser mode');
      return [];
    },
    selectClaudeRootFolder: async (): Promise<ClaudeRootFolderSelection | null> => {
      console.warn('[HttpAPIClient] selectClaudeRootFolder is not available in browser mode');
      return null;
    },
    getClaudeRootInfo: async (): Promise<ClaudeRootInfo> => {
      const config = await this.config.get();
      const fallbackPath = config.general.claudeRootPath ?? '~/.claude';
      return {
        defaultPath: fallbackPath,
        resolvedPath: fallbackPath,
        customPath: config.general.claudeRootPath,
      };
    },
    findWslClaudeRoots: async (): Promise<WslClaudeRootCandidate[]> => {
      console.warn('[HttpAPIClient] findWslClaudeRoots is not available in browser mode');
      return [];
    },
    openInEditor: async (): Promise<void> => {
      console.warn('[HttpAPIClient] openInEditor is not available in browser mode');
    },
    pinSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/pin-session', { projectId, sessionId }),
    unpinSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/unpin-session', { projectId, sessionId }),
    hideSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/hide-session', { projectId, sessionId }),
    unhideSession: (projectId: string, sessionId: string): Promise<void> =>
      this.post('/api/config/unhide-session', { projectId, sessionId }),
    hideSessions: (projectId: string, sessionIds: string[]): Promise<void> =>
      this.post('/api/config/hide-sessions', { projectId, sessionIds }),
    unhideSessions: (projectId: string, sessionIds: string[]): Promise<void> =>
      this.post('/api/config/unhide-sessions', { projectId, sessionIds }),
    addCustomProjectPath: (projectPath: string): Promise<void> =>
      this.post('/api/config/add-custom-project-path', { projectPath }),
    removeCustomProjectPath: (projectPath: string): Promise<void> =>
      this.post('/api/config/remove-custom-project-path', { projectPath }),
  };

  // ---------------------------------------------------------------------------
  // Session navigation
  // ---------------------------------------------------------------------------

  session: SessionAPI = {
    scrollToLine: (sessionId: string, lineNumber: number): Promise<void> =>
      this.post('/api/session/scroll-to-line', { sessionId, lineNumber }),
  };

  // ---------------------------------------------------------------------------
  // Zoom (browser fallbacks)
  // ---------------------------------------------------------------------------

  getZoomFactor = async (): Promise<number> => 1.0;

  onZoomFactorChanged = (_callback: (zoomFactor: number) => void): (() => void) => {
    // No-op in browser mode — zoom is managed by the browser itself
    return () => {};
  };

  // ---------------------------------------------------------------------------
  // File change events (via SSE)
  // ---------------------------------------------------------------------------

  onFileChange = (callback: (event: FileChangeEvent) => void): (() => void) =>
    this.addEventListener('file-change', callback);

  onTodoChange = (callback: (event: FileChangeEvent) => void): (() => void) =>
    this.addEventListener('todo-change', callback);

  // ---------------------------------------------------------------------------
  // Shell operations (browser fallbacks)
  // ---------------------------------------------------------------------------

  openPath = async (
    _targetPath: string,
    _projectRoot?: string
  ): Promise<{ success: boolean; error?: string }> => {
    console.warn('[HttpAPIClient] openPath is not available in browser mode');
    return { success: false, error: 'Not available in browser mode' };
  };

  showInFolder = async (_filePath: string): Promise<void> => {
    console.warn('[HttpAPIClient] showInFolder is not available in browser mode');
  };

  openExternal = async (url: string): Promise<{ success: boolean; error?: string }> => {
    window.open(url, '_blank');
    return { success: true };
  };

  windowControls = {
    minimize: async (): Promise<void> => {},
    maximize: async (): Promise<void> => {},
    close: async (): Promise<void> => {},
    isMaximized: async (): Promise<boolean> => false,
    isFullScreen: async (): Promise<boolean> => false,
    relaunch: async (): Promise<void> => {},
  };

  onFullScreenChange =
    (_callback: (isFullScreen: boolean) => void): (() => void) =>
    () => {};

  // ---------------------------------------------------------------------------
  // Updater (browser no-ops)
  // ---------------------------------------------------------------------------

  updater: UpdaterAPI = {
    check: async (): Promise<void> => {
      console.warn('[HttpAPIClient] updater not available in browser mode');
    },
    download: async (): Promise<void> => {
      console.warn('[HttpAPIClient] updater not available in browser mode');
    },
    install: async (): Promise<void> => {
      console.warn('[HttpAPIClient] updater not available in browser mode');
    },
    onStatus: (_callback): (() => void) => {
      return () => {};
    },
  };

  // ---------------------------------------------------------------------------
  // SSH
  // ---------------------------------------------------------------------------

  ssh: SshAPI = {
    connect: (config: SshConnectionConfig): Promise<SshConnectionStatus> =>
      this.post('/api/ssh/connect', config),
    disconnect: (): Promise<SshConnectionStatus> => this.post('/api/ssh/disconnect'),
    getState: (): Promise<SshConnectionStatus> => this.get('/api/ssh/state'),
    test: (config: SshConnectionConfig): Promise<{ success: boolean; error?: string }> =>
      this.post('/api/ssh/test', config),
    getConfigHosts: async (): Promise<SshConfigHostEntry[]> => {
      const result = await this.get<{ success: boolean; data?: SshConfigHostEntry[] }>(
        '/api/ssh/config-hosts'
      );
      return result.data ?? [];
    },
    resolveHost: async (alias: string): Promise<SshConfigHostEntry | null> => {
      const result = await this.post<{
        success: boolean;
        data?: SshConfigHostEntry | null;
      }>('/api/ssh/resolve-host', { alias });
      return result.data ?? null;
    },
    saveLastConnection: (config: SshLastConnection): Promise<void> =>
      this.post('/api/ssh/save-last-connection', config),
    getLastConnection: async (): Promise<SshLastConnection | null> => {
      const result = await this.get<{ success: boolean; data?: SshLastConnection | null }>(
        '/api/ssh/last-connection'
      );
      return result.data ?? null;
    },
    // IPC signature: (event: unknown, status: SshConnectionStatus) => void
    onStatus: (callback): (() => void) =>
      this.addEventListener('ssh:status', (data: unknown) =>
        callback(null, data as SshConnectionStatus)
      ),
  };

  // ---------------------------------------------------------------------------
  // Context API
  // ---------------------------------------------------------------------------

  context = {
    list: (): Promise<ContextInfo[]> => this.get<ContextInfo[]>('/api/contexts'),
    getActive: (): Promise<string> => this.get<string>('/api/contexts/active'),
    switch: (contextId: string): Promise<{ contextId: string }> =>
      this.post<{ contextId: string }>('/api/contexts/switch', { contextId }),
    onChanged: (callback: (event: unknown, data: ContextInfo) => void): (() => void) =>
      this.addEventListener('context:changed', (data: unknown) =>
        callback(null, data as ContextInfo)
      ),
  };

  // HTTP Server API — in browser mode, server is already running (we're using it)
  httpServer: HttpServerAPI = {
    start: (): Promise<HttpServerStatus> =>
      Promise.resolve({ running: true, port: parseInt(new URL(this.baseUrl).port, 10) }),
    stop: (): Promise<HttpServerStatus> => {
      console.warn('[HttpAPIClient] Cannot stop HTTP server from browser mode');
      return Promise.resolve({ running: true, port: parseInt(new URL(this.baseUrl).port, 10) });
    },
    getStatus: (): Promise<HttpServerStatus> =>
      Promise.resolve({ running: true, port: parseInt(new URL(this.baseUrl).port, 10) }),
  };

  teams: TeamsAPI = {
    list: (): Promise<TeamSummary[]> => this.get<TeamSummary[]>('/api/teams'),
    getData: async (teamName: string): Promise<TeamData> => {
      const encodedTeamName = encodeURIComponent(teamName);
      const data = await this.get<TeamData>(`/api/teams/${encodedTeamName}`);
      if (typeof data.isAlive === 'boolean') {
        return data;
      }

      try {
        const isAlive = await this.get<boolean>(`/api/teams/${encodedTeamName}/process/alive`);
        return {
          ...data,
          isAlive,
        };
      } catch {
        return {
          ...data,
          isAlive: false,
        };
      }
    },
    getClaudeLogs: (
      teamName: string,
      query?: TeamClaudeLogsQuery
    ): Promise<TeamClaudeLogsResponse> =>
      this.get<TeamClaudeLogsResponse>(
        `/api/teams/${encodeURIComponent(teamName)}/logs${this.buildQuery({
          offset: query?.offset,
          limit: query?.limit,
        })}`
      ),
    deleteTeam: (teamName: string): Promise<void> =>
      this.del(`/api/teams/${encodeURIComponent(teamName)}`),
    restoreTeam: (teamName: string): Promise<void> =>
      this.post(`/api/teams/${encodeURIComponent(teamName)}/restore`),
    permanentlyDeleteTeam: (teamName: string): Promise<void> =>
      this.del(`/api/teams/${encodeURIComponent(teamName)}/permanent`),
    getSavedRequest: async (teamName: string): Promise<TeamCreateRequest | null> =>
      this.get<TeamCreateRequest | null>(
        `/api/teams/${encodeURIComponent(teamName)}/saved-request`
      ),
    deleteDraft: (teamName: string): Promise<void> =>
      this.del(`/api/teams/${encodeURIComponent(teamName)}/draft`),
    prepareProvisioning: (cwd?: string): Promise<TeamProvisioningPrepareResult> =>
      this.post('/api/teams/prepare-provisioning', { cwd }),
    createTeam: (request: TeamCreateRequest): Promise<TeamCreateResponse> =>
      this.post<TeamCreateResponse>('/api/teams', request),
    getProvisioningStatus: (runId: string): Promise<TeamProvisioningProgress> =>
      this.get<TeamProvisioningProgress>(`/api/teams/provisioning/${encodeURIComponent(runId)}`),
    cancelProvisioning: (runId: string): Promise<void> =>
      this.post(`/api/teams/provisioning/${encodeURIComponent(runId)}/cancel`),
    sendMessage: (teamName: string, request: SendMessageRequest): Promise<SendMessageResult> =>
      this.post<SendMessageResult>(
        `/api/teams/${encodeURIComponent(teamName)}/send-message`,
        request
      ),
    createTask: (teamName: string, request: CreateTaskRequest): Promise<TeamTask> =>
      this.post<TeamTask>(`/api/teams/${encodeURIComponent(teamName)}/tasks`, request),
    requestReview: (teamName: string, taskId: string): Promise<void> =>
      this.post(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/request-review`
      ),
    updateKanban: (teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void> =>
      this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/kanban`,
        patch
      ),
    updateKanbanColumnOrder: (
      teamName: string,
      columnId: KanbanColumnId,
      orderedTaskIds: string[]
    ): Promise<void> =>
      this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/kanban/${encodeURIComponent(columnId)}/order`,
        {
          orderedTaskIds,
        }
      ),
    updateTaskStatus: (teamName: string, taskId: string, status: TeamTaskStatus): Promise<void> =>
      this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/status`,
        { status }
      ),
    updateTaskOwner: (teamName: string, taskId: string, owner: string | null): Promise<void> =>
      this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/owner`,
        { owner }
      ),
    updateTaskFields: (
      teamName: string,
      taskId: string,
      fields: { subject?: string; description?: string }
    ): Promise<void> =>
      this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/fields`,
        fields
      ),
    startTask: (teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> =>
      this.post(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/start`
      ),
    processSend: (teamName: string, message: string): Promise<void> =>
      this.post(`/api/teams/${encodeURIComponent(teamName)}/process/send`, { message }),
    processAlive: (teamName: string): Promise<boolean> =>
      this.get<boolean>(`/api/teams/${encodeURIComponent(teamName)}/process/alive`),
    aliveList: (): Promise<string[]> => this.get<string[]>('/api/teams/alive-list'),
    stop: (teamName: string): Promise<void> =>
      this.post(`/api/teams/${encodeURIComponent(teamName)}/stop`),
    createConfig: (request: TeamCreateConfigRequest): Promise<void> =>
      this.post('/api/teams/create-config', request),
    getMemberLogs: (teamName: string, memberName: string): Promise<MemberLogSummary[]> =>
      this.get<MemberLogSummary[]>(
        `/api/teams/${encodeURIComponent(teamName)}/member-logs/${encodeURIComponent(memberName)}`
      ),
    getLogsForTask: (
      teamName: string,
      taskId: string,
      options?: {
        owner?: string;
        status?: string;
        intervals?: { startedAt: string; completedAt?: string }[];
        since?: string;
      }
    ): Promise<MemberLogSummary[]> =>
      this.get<MemberLogSummary[]>(
        `/api/teams/${encodeURIComponent(teamName)}/logs-for-task/${encodeURIComponent(taskId)}${this.buildQuery(
          {
            owner: options?.owner,
            status: options?.status,
            since: options?.since,
            intervals: options?.intervals ? JSON.stringify(options.intervals) : undefined,
          }
        )}`
      ),
    getMemberStats: (teamName: string, memberName: string): Promise<MemberFullStats> =>
      this.get<MemberFullStats>(
        `/api/teams/${encodeURIComponent(teamName)}/member-stats/${encodeURIComponent(memberName)}`
      ),
    launchTeam: (request: TeamLaunchRequest): Promise<TeamLaunchResponse> =>
      this.post<TeamLaunchResponse>(
        `/api/teams/${encodeURIComponent(request.teamName)}/launch`,
        request
      ),
    getAllTasks: (): Promise<GlobalTask[]> => this.get<GlobalTask[]>('/api/teams/all-tasks'),
    updateConfig: (
      teamName: string,
      updates: TeamUpdateConfigRequest
    ): Promise<TeamData['config']> =>
      this.patch<TeamData['config']>(`/api/teams/${encodeURIComponent(teamName)}/config`, updates),
    addMember: (teamName: string, request: AddMemberRequest): Promise<void> =>
      this.post(`/api/teams/${encodeURIComponent(teamName)}/members`, request),
    replaceMembers: (teamName: string, request: ReplaceMembersRequest): Promise<void> =>
      this.put(`/api/teams/${encodeURIComponent(teamName)}/members`, request),
    removeMember: (teamName: string, memberName: string): Promise<void> =>
      this.del(
        `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(memberName)}`
      ),
    updateMemberRole: (
      teamName: string,
      memberName: string,
      role: string | undefined
    ): Promise<void> =>
      this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/members/${encodeURIComponent(memberName)}/role`,
        { role }
      ),
    addTaskComment: (
      teamName: string,
      taskId: string,
      request: AddTaskCommentRequest
    ): Promise<TaskComment> =>
      this.post<TaskComment>(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/comments`,
        request
      ),
    setTaskClarification: (
      teamName: string,
      taskId: string,
      value: 'lead' | 'user' | null
    ): Promise<void> =>
      this.patch(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/clarification`,
        { value }
      ),
    getProjectBranch: (projectPath: string): Promise<string | null> =>
      this.get<string | null>(`/api/teams/project-branch${this.buildQuery({ projectPath })}`),
    getAttachments: (teamName: string, messageId: string): Promise<AttachmentFileData[]> =>
      this.get<AttachmentFileData[]>(
        `/api/teams/${encodeURIComponent(teamName)}/attachments/${encodeURIComponent(messageId)}`
      ),
    killProcess: (teamName: string, pid: number): Promise<void> =>
      this.post(
        `/api/teams/${encodeURIComponent(teamName)}/process/${encodeURIComponent(pid)}/kill`
      ),
    getLeadActivity: (teamName: string): Promise<LeadActivitySnapshot> =>
      this.get<LeadActivitySnapshot>(`/api/teams/${encodeURIComponent(teamName)}/lead-activity`),
    getLeadContext: (teamName: string): Promise<LeadContextUsageSnapshot> =>
      this.get<LeadContextUsageSnapshot>(`/api/teams/${encodeURIComponent(teamName)}/lead-context`),
    getMemberSpawnStatuses: (teamName: string): Promise<MemberSpawnStatusesSnapshot> =>
      this.get<MemberSpawnStatusesSnapshot>(
        `/api/teams/${encodeURIComponent(teamName)}/member-spawn-statuses`
      ),
    softDeleteTask: (teamName: string, taskId: string): Promise<void> =>
      this.post(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/soft-delete`
      ),
    restoreTask: (teamName: string, taskId: string): Promise<void> =>
      this.post(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/restore`
      ),
    getDeletedTasks: (teamName: string): Promise<TeamTask[]> =>
      this.get<TeamTask[]>(`/api/teams/${encodeURIComponent(teamName)}/tasks/deleted`),
    showMessageNotification: async (data) => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(data.summary ?? data.teamDisplayName ?? 'Message notification', {
          body: data.body ?? '',
        });
        return;
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => undefined);
      }
    },
    addTaskRelationship: (
      teamName: string,
      taskId: string,
      targetId: string,
      type: 'blockedBy' | 'blocks' | 'related'
    ): Promise<void> =>
      this.post(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/relationships`,
        { targetId, type }
      ),
    removeTaskRelationship: (
      teamName: string,
      taskId: string,
      targetId: string,
      type: 'blockedBy' | 'blocks' | 'related'
    ): Promise<void> =>
      this.del(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/relationships/${encodeURIComponent(targetId)}`,
        { type }
      ),
    saveTaskAttachment: (
      teamName: string,
      taskId: string,
      attachmentId: string,
      filename: string,
      mimeType: string,
      base64Data: string
    ): Promise<TaskAttachmentMeta> =>
      this.post<TaskAttachmentMeta>(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/attachments`,
        { attachmentId, filename, mimeType, base64Data }
      ),
    getTaskAttachment: (
      teamName: string,
      taskId: string,
      attachmentId: string,
      mimeType: string
    ): Promise<string | null> =>
      this.get<string | null>(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}${this.buildQuery({ mimeType })}`
      ),
    deleteTaskAttachment: (
      teamName: string,
      taskId: string,
      attachmentId: string,
      mimeType: string
    ): Promise<void> =>
      this.del(
        `/api/teams/${encodeURIComponent(teamName)}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}${this.buildQuery({ mimeType })}`
      ),
    onTeamChange: (callback: (event: unknown, data: TeamChangeEvent) => void): (() => void) =>
      this.addEventListener('team:change', (data: unknown) =>
        callback(null, data as TeamChangeEvent)
      ),
    onProvisioningProgress: (
      callback: (event: unknown, data: TeamProvisioningProgress) => void
    ): (() => void) =>
      this.addEventListener('team:provisioningProgress', (data: unknown) =>
        callback(null, data as TeamProvisioningProgress)
      ),
    respondToToolApproval: (
      teamName: string,
      runId: string,
      requestId: string,
      allow: boolean,
      message?: string
    ): Promise<void> =>
      this.post(`/api/teams/${encodeURIComponent(teamName)}/tool-approval/respond`, {
        runId,
        requestId,
        allow,
        message,
      }),
    validateCliArgs: (rawArgs: string): Promise<CliArgsValidationResult> =>
      this.post<CliArgsValidationResult>('/api/teams/tool-approval/validate-cli-args', {
        rawArgs,
      }),
    onToolApprovalEvent: (
      callback: (event: unknown, data: ToolApprovalEvent) => void
    ): (() => void) =>
      this.addEventListener('team:toolApprovalEvent', (data: unknown) =>
        callback(null, data as ToolApprovalEvent)
      ),
    updateToolApprovalSettings: (settings: ToolApprovalSettings): Promise<void> =>
      this.patch('/api/teams/tool-approval/settings', settings),
    readFileForToolApproval: (filePath: string): Promise<ToolApprovalFileContent> =>
      this.post<ToolApprovalFileContent>('/api/teams/tool-approval/read-file', { filePath }),
  };

  // Cross-team communication API
  crossTeam: CrossTeamAPI = {
    send: (request) => this.post('/api/cross-team/send', request),
    listTargets: (excludeTeam?: string) =>
      this.get('/api/cross-team/targets' + this.buildQuery({ excludeTeam })),
    getOutbox: (teamName: string) =>
      this.get(`/api/cross-team/${encodeURIComponent(teamName)}/outbox`),
  };

  // Review API
  review: ElectronAPI['review'] = {
    getAgentChanges: (teamName: string, memberName: string): Promise<any> =>
      this.get(`/api/review/agent-changes${this.buildQuery({ teamName, memberName })}`),
    getTaskChanges: (
      teamName: string,
      taskId: string,
      options?: {
        owner?: string;
        status?: string;
        intervals?: { startedAt: string; completedAt?: string }[];
        since?: string;
        stateBucket?: 'approved' | 'review' | 'completed' | 'active';
        summaryOnly?: boolean;
        forceFresh?: boolean;
      }
    ): Promise<any> =>
      this.get(
        `/api/review/task-changes${this.buildQuery({
          teamName,
          taskId,
          owner: options?.owner,
          status: options?.status,
          intervals: options?.intervals ? JSON.stringify(options.intervals) : undefined,
          since: options?.since,
          stateBucket: options?.stateBucket,
          summaryOnly: options?.summaryOnly,
          forceFresh: options?.forceFresh,
        })}`
      ),
    invalidateTaskChangeSummaries: (teamName: string, taskIds: string[]): Promise<void> =>
      this.post('/api/review/invalidate-task-change-summaries', { teamName, taskIds }),
    getChangeStats: (teamName: string, memberName: string): Promise<any> =>
      this.get(`/api/review/change-stats${this.buildQuery({ teamName, memberName })}`),
    getFileContent: (
      teamName: string,
      memberName: string | undefined,
      filePath: string,
      snippets: SnippetDiff[] = []
    ): Promise<FileChangeWithContent> =>
      this.get<FileChangeWithContent>(
        `/api/review/file-content${this.buildQuery({
          teamName,
          memberName,
          filePath,
          snippets: snippets.length > 0 ? JSON.stringify(snippets) : undefined,
        })}`
      ),
    applyDecisions: (request: ApplyReviewRequest): Promise<ApplyReviewResult> =>
      this.post<ApplyReviewResult>('/api/review/apply-decisions', request),
    checkConflict: (filePath: string, expectedModified: string): Promise<any> =>
      this.get(`/api/review/check-conflict${this.buildQuery({ filePath, expectedModified })}`),
    rejectHunks: (
      filePath: string,
      original: string,
      modified: string,
      hunkIndices: number[],
      snippets: SnippetDiff[]
    ): Promise<any> =>
      this.post('/api/review/reject-hunks', {
        filePath,
        original,
        modified,
        hunkIndices,
        snippets,
      }),
    rejectFile: (filePath: string, original: string, modified: string): Promise<any> =>
      this.post('/api/review/reject-file', { filePath, original, modified }),
    previewReject: (
      filePath: string,
      original: string,
      modified: string,
      hunkIndices: number[],
      snippets: SnippetDiff[]
    ): Promise<{ preview: string; hasConflicts: boolean }> =>
      this.post('/api/review/preview-reject', {
        filePath,
        original,
        modified,
        hunkIndices,
        snippets,
      }),
    saveEditedFile: (filePath: string, content: string, projectPath?: string): Promise<any> =>
      this.post('/api/review/save-edited-file', { filePath, content, projectPath }),
    watchFiles: (projectPath: string, filePaths: string[]): Promise<void> =>
      this.post('/api/review/watch-files', { projectPath, filePaths }),
    unwatchFiles: (): Promise<void> => this.post('/api/review/unwatch-files'),
    onExternalFileChange: (callback: (event: EditorFileChangeEvent) => void): (() => void) =>
      this.addEventListener('review:fileChange', callback),
    loadDecisions: (teamName: string, scopeKey: string) =>
      this.get(`/api/review/decisions${this.buildQuery({ teamName, scopeKey })}`),
    saveDecisions: (
      teamName: string,
      scopeKey: string,
      hunkDecisions: Record<string, HunkDecision>,
      fileDecisions: Record<string, HunkDecision>,
      hunkContextHashesByFile?: Record<string, Record<number, string>>
    ): Promise<void> =>
      this.post('/api/review/decisions', {
        teamName,
        scopeKey,
        hunkDecisions,
        fileDecisions,
        hunkContextHashesByFile,
      }),
    clearDecisions: (teamName: string, scopeKey: string): Promise<void> =>
      this.del('/api/review/decisions', { teamName, scopeKey }),
    getGitFileLog: (projectPath: string, filePath: string) =>
      this.get(`/api/review/git-file-log${this.buildQuery({ projectPath, filePath })}`),
  };

  // ---------------------------------------------------------------------------
  // CLI Installer (not available in browser mode)
  // ---------------------------------------------------------------------------

  cliInstaller: CliInstallerAPI = {
    getStatus: async () => ({
      installed: false,
      installedVersion: null,
      binaryPath: null,
      latestVersion: null,
      updateAvailable: false,
      authLoggedIn: false,
      authMethod: null,
    }),
    install: async (): Promise<void> => {
      console.warn('[HttpAPIClient] CLI installer not available in browser mode');
    },
    onProgress: (): (() => void) => {
      return () => {};
    },
  };

  // ---------------------------------------------------------------------------
  // Terminal (not available in browser mode)
  // ---------------------------------------------------------------------------

  terminal: TerminalAPI = {
    spawn: async (): Promise<string> => {
      throw new Error('Terminal not available in browser mode');
    },
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: (): (() => void) => () => {},
    onExit: (): (() => void) => () => {},
  };

  // ---------------------------------------------------------------------------
  // Project (not available in browser mode)
  // ---------------------------------------------------------------------------

  project: ProjectAPI = {
    listFiles: (projectPath: string) =>
      this.get(`/api/project/list-files${this.buildQuery({ projectPath })}`),
  };

  // ---------------------------------------------------------------------------
  // Editor
  // ---------------------------------------------------------------------------

  editor: EditorAPI = {
    open: (projectPath: string) => this.post('/api/editor/open', { projectPath }),
    close: () => this.post('/api/editor/close'),
    readDir: (dirPath: string, maxEntries?: number) =>
      this.get(
        `/api/editor/read-dir${this.buildQuery({
          dirPath,
          maxEntries,
        })}`
      ),
    readFile: (filePath: string) =>
      this.get(`/api/editor/read-file${this.buildQuery({ filePath })}`),
    writeFile: (filePath: string, content: string, baselineMtimeMs?: number) =>
      this.post('/api/editor/write-file', { filePath, content, baselineMtimeMs }),
    createFile: (parentDir: string, fileName: string) =>
      this.post('/api/editor/create-file', { parentDir, fileName }),
    createDir: (parentDir: string, dirName: string) =>
      this.post('/api/editor/create-dir', { parentDir, dirName }),
    deleteFile: (filePath: string) => this.post('/api/editor/delete-file', { filePath }),
    moveFile: (sourcePath: string, destDir: string) =>
      this.post('/api/editor/move-file', { sourcePath, destDir }),
    renameFile: (sourcePath: string, newName: string) =>
      this.post('/api/editor/rename-file', { sourcePath, newName }),
    searchInFiles: (options) => this.post('/api/editor/search-in-files', options),
    listFiles: () => this.get('/api/editor/list-files'),
    readBinaryPreview: (filePath: string) =>
      this.get(`/api/editor/read-binary-preview${this.buildQuery({ filePath })}`),
    gitStatus: () => this.get('/api/editor/git-status'),
    watchDir: (enable: boolean) => this.post('/api/editor/watch-dir', { enable }),
    setWatchedFiles: (filePaths: string[]) =>
      this.post('/api/editor/set-watched-files', { filePaths }),
    setWatchedDirs: (dirPaths: string[]) => this.post('/api/editor/set-watched-dirs', { dirPaths }),
    onEditorChange: (callback: (event: EditorFileChangeEvent) => void) =>
      this.addEventListener('editor:change', callback),
  };

  schedules = {
    list: async () => {
      console.warn('Schedules not available in browser mode');
      return [] as Schedule[];
    },
    get: async () => {
      console.warn('Schedules not available in browser mode');
      return null;
    },
    create: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    update: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    delete: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    pause: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    resume: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    triggerNow: async () => {
      throw new Error('Schedules not available in browser mode');
    },
    getRuns: async () => {
      console.warn('Schedules not available in browser mode');
      return [] as ScheduleRun[];
    },
    getRunLogs: async () => {
      console.warn('Schedules not available in browser mode');
      return { stdout: '', stderr: '' };
    },
    onScheduleChange: () => {
      return () => {};
    },
  };

  getPathForFile = (_file: File): string => '';
}
