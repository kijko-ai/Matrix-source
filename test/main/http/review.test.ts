import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerReviewRoutes } from '@main/http/review';
import type { HttpServices } from '@main/http';

describe('HTTP review routes', () => {
  function createServicesMock() {
    const getTaskChanges = vi.fn();
    const getFileContent = vi.fn();
    const getFileLog = vi.fn();
    const applyReviewDecisions = vi.fn();
    const changeExtractor = {
      getTaskChanges,
    } as unknown as NonNullable<HttpServices['changeExtractor']>;
    const fileContentResolver = {
      getFileContent,
    } as unknown as NonNullable<HttpServices['fileContentResolver']>;
    const gitDiffFallback = {
      getFileLog,
    } as unknown as NonNullable<HttpServices['gitDiffFallback']>;
    const reviewApplier = {
      applyReviewDecisions,
    } as unknown as NonNullable<HttpServices['reviewApplier']>;

    const services = {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      changeExtractor,
      fileContentResolver,
      gitDiffFallback,
      reviewApplier,
    } satisfies HttpServices;

    return {
      services,
      changeExtractor,
      fileContentResolver,
      gitDiffFallback,
      reviewApplier,
      getTaskChanges,
      getFileContent,
      getFileLog,
      applyReviewDecisions,
    };
  }

  it('parses browser task-change query state and forwards it to the extractor', async () => {
    const app = Fastify();
    const mocks = createServicesMock();
    registerReviewRoutes(app, mocks.services);
    await app.ready();

    const taskChanges = { teamName: 'team-a', taskId: 'task-1', files: [] };
    mocks.getTaskChanges.mockResolvedValue(taskChanges);

    try {
      const params = new URLSearchParams({
        teamName: 'team-a',
        taskId: 'task-1',
        owner: 'alice',
        status: 'completed',
        since: '2026-03-01T09:00:00.000Z',
        stateBucket: 'review',
        summaryOnly: 'true',
        forceFresh: 'true',
        intervals: JSON.stringify([
          {
            startedAt: '2026-03-01T10:00:00.000Z',
            completedAt: '2026-03-01T11:00:00.000Z',
          },
        ]),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/review/task-changes?${params.toString()}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(taskChanges);
      expect(mocks.getTaskChanges).toHaveBeenCalledWith('team-a', 'task-1', {
        owner: 'alice',
        status: 'completed',
        since: '2026-03-01T09:00:00.000Z',
        intervals: [
          {
            startedAt: '2026-03-01T10:00:00.000Z',
            completedAt: '2026-03-01T11:00:00.000Z',
          },
        ],
        stateBucket: 'review',
        summaryOnly: true,
        forceFresh: true,
      });
    } finally {
      await app.close();
    }
  });

  it('accepts browser-encoded snippets and uses git diff fallback for file logs', async () => {
    const app = Fastify();
    const mocks = createServicesMock();
    registerReviewRoutes(app, mocks.services);
    await app.ready();

    mocks.getFileContent.mockResolvedValue({
      filePath: '/repo/file.ts',
      originalFullContent: 'before',
      modifiedFullContent: 'after',
      contentSource: 'disk',
    });
    mocks.getFileLog.mockReturnValue([
      { hash: 'abc123', timestamp: '2026-03-01T12:00:00.000Z', message: 'Update file' },
    ]);

    try {
      const snippets = [
        {
          type: 'edit',
          isError: false,
        },
      ];
      const fileContentParams = new URLSearchParams({
        teamName: 'team-a',
        memberName: 'alice',
        filePath: '/repo/file.ts',
        snippets: JSON.stringify(snippets),
      });

      const fileContentResponse = await app.inject({
        method: 'GET',
        url: `/api/review/file-content?${fileContentParams.toString()}`,
      });

      expect(fileContentResponse.statusCode).toBe(200);
      expect(mocks.getFileContent).toHaveBeenCalledWith(
        'team-a',
        'alice',
        '/repo/file.ts',
        snippets
      );

      const gitFileLogResponse = await app.inject({
        method: 'GET',
        url: '/api/review/git-file-log?projectPath=%2Frepo%2Fproject&filePath=%2Frepo%2Ffile.ts',
      });

      expect(gitFileLogResponse.statusCode).toBe(200);
      expect(gitFileLogResponse.json()).toEqual([
        { hash: 'abc123', timestamp: '2026-03-01T12:00:00.000Z', message: 'Update file' },
      ]);
      expect(mocks.getFileLog).toHaveBeenCalledWith(
        '/repo/project',
        '/repo/file.ts'
      );
    } finally {
      await app.close();
    }
  });
});
