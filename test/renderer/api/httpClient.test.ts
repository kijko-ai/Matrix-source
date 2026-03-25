import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpAPIClient } from '../../../src/renderer/api/httpClient';

type Listener = (event: MessageEvent<string>) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener as Listener);
    this.listeners.set(type, set);
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close(): void {}
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(
    JSON.stringify(body),
    {
      status: init?.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    }
  );
}

describe('HttpAPIClient browser transport', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    MockEventSource.instances = [];
    fetchMock.mockReset();
    vi.stubGlobal('EventSource', MockEventSource as never);
    vi.stubGlobal('fetch', fetchMock as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes teams, review, editor, and SSE calls through the HTTP API', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse('main'))
      .mockResolvedValueOnce(jsonResponse({ teamName: 'team-a', taskId: 'task-1', files: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    const client = new HttpAPIClient('http://127.0.0.1:3456');

    const teamChanges: unknown[] = [];
    const provisioningProgress: unknown[] = [];
    const toolApprovalEvents: unknown[] = [];
    const reviewChanges: unknown[] = [];
    const editorChanges: unknown[] = [];

    const cleanupTeam = client.teams.onTeamChange((_event, data) => teamChanges.push(data));
    const cleanupProvisioning = client.teams.onProvisioningProgress((_event, data) =>
      provisioningProgress.push(data)
    );
    const cleanupToolApproval = client.teams.onToolApprovalEvent((_event, data) =>
      toolApprovalEvents.push(data)
    );
    const cleanupReview = client.review.onExternalFileChange((data) => reviewChanges.push(data));
    const cleanupEditor = client.editor.onEditorChange((data) => editorChanges.push(data));

    try {
      expect(await client.teams.getProjectBranch('/workspace/project')).toBe('main');
      await client.review.getTaskChanges('team-a', 'task-1', {
        owner: 'alice',
        status: 'completed',
        intervals: [{ startedAt: '2026-03-01T10:00:00.000Z', completedAt: '2026-03-01T11:00:00.000Z' }],
        since: '2026-03-01T09:00:00.000Z',
        stateBucket: 'review',
        summaryOnly: true,
        forceFresh: true,
      });
      await client.review.watchFiles('/workspace/project', ['/workspace/project/src/b.ts']);
      await client.editor.setWatchedFiles(['/workspace/project/src/a.ts']);
      await client.editor.setWatchedDirs(['/workspace/project', '/workspace/project/src']);

      expect(fetchMock).toHaveBeenCalledTimes(5);

      const branchUrl = new URL(fetchMock.mock.calls[0][0] as string);
      expect(branchUrl.pathname).toBe('/api/teams/project-branch');
      expect(branchUrl.searchParams.get('projectPath')).toBe('/workspace/project');

      const taskChangesUrl = new URL(fetchMock.mock.calls[1][0] as string);
      expect(taskChangesUrl.pathname).toBe('/api/review/task-changes');
      expect(taskChangesUrl.searchParams.get('teamName')).toBe('team-a');
      expect(taskChangesUrl.searchParams.get('taskId')).toBe('task-1');
      expect(taskChangesUrl.searchParams.get('owner')).toBe('alice');
      expect(taskChangesUrl.searchParams.get('status')).toBe('completed');
      expect(taskChangesUrl.searchParams.get('since')).toBe('2026-03-01T09:00:00.000Z');
      expect(taskChangesUrl.searchParams.get('stateBucket')).toBe('review');
      expect(taskChangesUrl.searchParams.get('summaryOnly')).toBe('true');
      expect(taskChangesUrl.searchParams.get('forceFresh')).toBe('true');
      expect(JSON.parse(taskChangesUrl.searchParams.get('intervals') ?? '[]')).toEqual([
        {
          startedAt: '2026-03-01T10:00:00.000Z',
          completedAt: '2026-03-01T11:00:00.000Z',
        },
      ]);

      expect(new URL(fetchMock.mock.calls[2][0] as string).pathname).toBe('/api/review/watch-files');
      expect(new URL(fetchMock.mock.calls[3][0] as string).pathname).toBe('/api/editor/set-watched-files');
      expect(new URL(fetchMock.mock.calls[4][0] as string).pathname).toBe('/api/editor/set-watched-dirs');

      const source = MockEventSource.instances[0];
      source.emit('team:change', { teamName: 'team-a' });
      source.emit('team:provisioningProgress', { state: 'ready' });
      source.emit('team:toolApprovalEvent', { requestId: 'r-1' });
      source.emit('review:fileChange', { path: '/workspace/project/src/a.ts' });
      source.emit('editor:change', { path: '/workspace/project/src/a.ts' });

      expect(teamChanges).toEqual([{ teamName: 'team-a' }]);
      expect(provisioningProgress).toEqual([{ state: 'ready' }]);
      expect(toolApprovalEvents).toEqual([{ requestId: 'r-1' }]);
      expect(reviewChanges).toEqual([{ path: '/workspace/project/src/a.ts' }]);
      expect(editorChanges).toEqual([{ path: '/workspace/project/src/a.ts' }]);
    } finally {
      cleanupTeam();
      cleanupProvisioning();
      cleanupToolApproval();
      cleanupReview();
      cleanupEditor();
    }
  });

  it('backfills isAlive from process/alive when team data omits the field', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          teamName: 'team-a',
          config: { name: 'Team A' },
          tasks: [],
          members: [],
          messages: [],
          kanbanState: { teamName: 'team-a', reviewers: [], tasks: {} },
          processes: [],
        })
      )
      .mockResolvedValueOnce(jsonResponse(true));

    const client = new HttpAPIClient('http://127.0.0.1:3456');

    const data = await client.teams.getData('team-a');

    expect(data.isAlive).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe('/api/teams/team-a');
    expect(new URL(fetchMock.mock.calls[1][0] as string).pathname).toBe(
      '/api/teams/team-a/process/alive'
    );
  });
});
