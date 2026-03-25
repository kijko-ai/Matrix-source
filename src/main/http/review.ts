import { validateFilePath } from '@main/utils/pathValidation';
import { createLogger } from '@shared/utils/logger';
import path from 'path';

import {
  ChangeExtractorService,
  FileContentResolver,
  GitDiffFallback,
  ReviewApplierService,
} from '../services';
import { EditorFileWatcher } from '../services/editor';
import { ReviewDecisionStore } from '../services/team/ReviewDecisionStore';
import type { HttpServices } from './index';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:review');

class HttpBadRequestError extends Error {}
class HttpFeatureUnavailableError extends Error {}

const reviewDecisionStore = new ReviewDecisionStore();
const reviewWatcher = new EditorFileWatcher();
let reviewWatcherProjectRoot: string | null = null;

function getChangeExtractor(services: HttpServices): ChangeExtractorService {
  if (!services.changeExtractor) {
    throw new HttpFeatureUnavailableError('Review changes are not available in this mode');
  }
  return services.changeExtractor;
}

function getContentResolver(services: HttpServices): FileContentResolver {
  if (!services.fileContentResolver) {
    throw new HttpFeatureUnavailableError('Review file content resolution is not available');
  }
  return services.fileContentResolver;
}

function getApplier(services: HttpServices): ReviewApplierService {
  if (!services.reviewApplier) {
    throw new HttpFeatureUnavailableError('Review application is not available in this mode');
  }
  return services.reviewApplier;
}

function getGitDiffFallback(services: HttpServices): GitDiffFallback {
  if (!services.gitDiffFallback) {
    throw new HttpFeatureUnavailableError('Git file history is not available in this mode');
  }
  return services.gitDiffFallback;
}

function getStatusCode(error: unknown, fallback = 500): number {
  if (error instanceof HttpBadRequestError) return 400;
  if (error instanceof HttpFeatureUnavailableError) return 501;
  return fallback;
}

function parseQueryOptions(options: unknown): Record<string, unknown> | undefined {
  if (!options || typeof options !== 'object') return undefined;
  return options as Record<string, unknown>;
}

function getProjectRoot(projectPath: unknown): string {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    throw new HttpBadRequestError('projectPath is required');
  }
  const normalized = path.resolve(projectPath.trim());
  return normalized;
}

function startReviewWatcher(services: HttpServices, projectRoot: string): void {
  reviewWatcherProjectRoot = projectRoot;
  reviewWatcher.start(projectRoot, (event) => {
    services.eventBroadcaster?.('review:fileChange', event);
  });
}

function stopReviewWatcher(): void {
  reviewWatcher.stop();
  reviewWatcherProjectRoot = null;
}

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseSnippets(value: unknown): { type: string; isError?: boolean }[] {
  return parseJsonArray<{ type: string; isError?: boolean }>(value);
}

function parseIntervals(value: unknown): { startedAt: string; completedAt?: string }[] {
  return parseJsonArray<{ startedAt: string; completedAt?: string }>(value).filter(
    (interval): interval is { startedAt: string; completedAt?: string } =>
      typeof interval.startedAt === 'string' &&
      (interval.completedAt === undefined || typeof interval.completedAt === 'string')
  );
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function parseStateBucket(
  value: unknown
): 'approved' | 'review' | 'completed' | 'active' | undefined {
  if (value === 'approved' || value === 'review' || value === 'completed' || value === 'active') {
    return value;
  }
  return undefined;
}

export function registerReviewRoutes(app: FastifyInstance, services: HttpServices): void {
  app.get('/api/review/agent-changes', async (request, reply) => {
    try {
      const q = request.query as { teamName?: unknown; memberName?: unknown } | undefined;
      if (typeof q?.teamName !== 'string' || typeof q.memberName !== 'string') {
        throw new HttpBadRequestError('teamName and memberName are required');
      }
      return reply.send(
        await getChangeExtractor(services).getAgentChanges(q.teamName, q.memberName)
      );
    } catch (error) {
      logger.error('Error in GET /api/review/agent-changes:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/review/task-changes', async (request, reply) => {
    try {
      const q = request.query as { teamName?: unknown; taskId?: unknown } | undefined;
      if (typeof q?.teamName !== 'string' || typeof q.taskId !== 'string') {
        throw new HttpBadRequestError('teamName and taskId are required');
      }
      const opts = parseQueryOptions(request.query);
      return reply.send(
        await getChangeExtractor(services).getTaskChanges(q.teamName, q.taskId, {
          owner: typeof opts?.owner === 'string' ? opts.owner : undefined,
          status: typeof opts?.status === 'string' ? opts.status : undefined,
          since: typeof opts?.since === 'string' ? opts.since : undefined,
          intervals: parseIntervals(opts?.intervals),
          stateBucket: parseStateBucket(opts?.stateBucket),
          summaryOnly: parseBoolean(opts?.summaryOnly),
          forceFresh: parseBoolean(opts?.forceFresh),
        })
      );
    } catch (error) {
      logger.error('Error in GET /api/review/task-changes:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/review/invalidate-task-change-summaries', async (request, reply) => {
    try {
      const body = request.body as { teamName?: unknown; taskIds?: unknown } | undefined;
      if (typeof body?.teamName !== 'string' || !Array.isArray(body?.taskIds)) {
        throw new HttpBadRequestError('teamName and taskIds are required');
      }
      await getChangeExtractor(services).invalidateTaskChangeSummaries(
        body.teamName,
        body.taskIds.filter((id): id is string => typeof id === 'string')
      );
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Error in POST /api/review/invalidate-task-change-summaries:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/review/change-stats', async (request, reply) => {
    try {
      const q = request.query as { teamName?: unknown; memberName?: unknown } | undefined;
      if (typeof q?.teamName !== 'string' || typeof q.memberName !== 'string') {
        throw new HttpBadRequestError('teamName and memberName are required');
      }
      return reply.send(
        await getChangeExtractor(services).getChangeStats(q.teamName, q.memberName)
      );
    } catch (error) {
      logger.error('Error in GET /api/review/change-stats:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/review/file-content', async (request, reply) => {
    try {
      const q = request.query as
        | { teamName?: unknown; memberName?: unknown; filePath?: unknown }
        | undefined;
      if (typeof q?.teamName !== 'string' || typeof q?.filePath !== 'string') {
        throw new HttpBadRequestError('teamName and filePath are required');
      }
      const teamName = q.teamName;
      const memberName = typeof q.memberName === 'string' ? q.memberName : '';
      const filePath = q.filePath;
      const snippets = parseSnippets(
        (request.query as { snippets?: unknown } | undefined)?.snippets
      );
      return reply.send(
        await getContentResolver(services).getFileContent(
          teamName,
          memberName,
          filePath,
          snippets as never
        )
      );
    } catch (error) {
      logger.error('Error in GET /api/review/file-content:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/review/apply-decisions', async (request, reply) => {
    try {
      return reply.send(await getApplier(services).applyReviewDecisions(request.body as never));
    } catch (error) {
      logger.error('Error in POST /api/review/apply-decisions:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/review/check-conflict', async (request, reply) => {
    try {
      const q = request.query as { filePath?: unknown; expectedModified?: unknown } | undefined;
      if (typeof q?.filePath !== 'string' || typeof q.expectedModified !== 'string') {
        throw new HttpBadRequestError('filePath and expectedModified are required');
      }
      return reply.send(await getApplier(services).checkConflict(q.filePath, q.expectedModified));
    } catch (error) {
      logger.error('Error in GET /api/review/check-conflict:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/review/reject-hunks', async (request, reply) => {
    try {
      const body = request.body as
        | {
            teamName?: unknown;
            filePath?: unknown;
            original?: unknown;
            modified?: unknown;
            hunkIndices?: unknown;
            snippets?: unknown;
          }
        | undefined;
      if (
        typeof body?.teamName !== 'string' ||
        typeof body.filePath !== 'string' ||
        typeof body.original !== 'string' ||
        typeof body.modified !== 'string' ||
        !Array.isArray(body.hunkIndices)
      ) {
        throw new HttpBadRequestError('Invalid request');
      }
      return reply.send(
        await getApplier(services).rejectHunks(
          body.teamName,
          body.filePath,
          body.original,
          body.modified,
          body.hunkIndices.filter((n): n is number => typeof n === 'number'),
          Array.isArray(body.snippets) ? (body.snippets as never) : []
        )
      );
    } catch (error) {
      logger.error('Error in POST /api/review/reject-hunks:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/review/reject-file', async (request, reply) => {
    try {
      const body = request.body as
        | { teamName?: unknown; filePath?: unknown; original?: unknown; modified?: unknown }
        | undefined;
      if (
        typeof body?.teamName !== 'string' ||
        typeof body.filePath !== 'string' ||
        typeof body.original !== 'string' ||
        typeof body.modified !== 'string'
      ) {
        throw new HttpBadRequestError('Invalid request');
      }
      return reply.send(
        await getApplier(services).rejectFile(
          body.teamName,
          body.filePath,
          body.original,
          body.modified
        )
      );
    } catch (error) {
      logger.error('Error in POST /api/review/reject-file:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/review/preview-reject', async (request, reply) => {
    try {
      const body = request.body as
        | {
            filePath?: unknown;
            original?: unknown;
            modified?: unknown;
            hunkIndices?: unknown;
            snippets?: unknown;
          }
        | undefined;
      if (
        typeof body?.filePath !== 'string' ||
        typeof body.original !== 'string' ||
        typeof body.modified !== 'string' ||
        !Array.isArray(body.hunkIndices)
      ) {
        throw new HttpBadRequestError('Invalid request');
      }
      return reply.send(
        await getApplier(services).previewReject(
          body.filePath,
          body.original,
          body.modified,
          body.hunkIndices.filter((n): n is number => typeof n === 'number'),
          Array.isArray(body.snippets) ? (body.snippets as never) : []
        )
      );
    } catch (error) {
      logger.error('Error in POST /api/review/preview-reject:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/review/save-edited-file', async (request, reply) => {
    try {
      const body = request.body as
        | { filePath?: unknown; content?: unknown; projectPath?: unknown }
        | undefined;
      if (typeof body?.filePath !== 'string' || typeof body.content !== 'string') {
        throw new HttpBadRequestError('filePath and content are required');
      }
      const validation = validateFilePath(
        body.filePath,
        typeof body.projectPath === 'string'
          ? path.resolve(body.projectPath)
          : reviewWatcherProjectRoot
      );
      if (!validation.valid || !validation.normalizedPath) {
        throw new HttpBadRequestError(validation.error ?? 'Invalid filePath');
      }
      return reply.send(
        await getApplier(services).saveEditedFile(validation.normalizedPath, body.content)
      );
    } catch (error) {
      logger.error('Error in POST /api/review/save-edited-file:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/review/watch-files', async (request, reply) => {
    try {
      const body = request.body as { projectPath?: unknown; filePaths?: unknown } | undefined;
      if (typeof body?.projectPath !== 'string' || !Array.isArray(body.filePaths)) {
        throw new HttpBadRequestError('projectPath and filePaths are required');
      }
      const projectRoot = path.resolve(body.projectPath);
      startReviewWatcher(services, projectRoot);
      reviewWatcher.setWatchedFiles(
        body.filePaths.filter((item): item is string => typeof item === 'string')
      );
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Error in POST /api/review/watch-files:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/review/unwatch-files', async (_request, reply) => {
    try {
      stopReviewWatcher();
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Error in POST /api/review/unwatch-files:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/review/git-file-log', async (request, reply) => {
    try {
      const q = request.query as { projectPath?: unknown; filePath?: unknown } | undefined;
      if (typeof q?.projectPath !== 'string' || typeof q.filePath !== 'string') {
        throw new HttpBadRequestError('projectPath and filePath are required');
      }
      return reply.send(getGitDiffFallback(services).getFileLog(q.projectPath, q.filePath));
    } catch (error) {
      logger.error('Error in GET /api/review/git-file-log:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/review/decisions', async (request, reply) => {
    try {
      const q = request.query as { teamName?: unknown; scopeKey?: unknown } | undefined;
      if (typeof q?.teamName !== 'string' || typeof q.scopeKey !== 'string') {
        throw new HttpBadRequestError('teamName and scopeKey are required');
      }
      return reply.send(await reviewDecisionStore.load(q.teamName, q.scopeKey));
    } catch (error) {
      logger.error('Error in GET /api/review/decisions:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/review/decisions', async (request, reply) => {
    try {
      const body = request.body as
        | {
            teamName?: unknown;
            scopeKey?: unknown;
            hunkDecisions?: unknown;
            fileDecisions?: unknown;
            hunkContextHashesByFile?: unknown;
          }
        | undefined;
      if (
        typeof body?.teamName !== 'string' ||
        typeof body.scopeKey !== 'string' ||
        typeof body.hunkDecisions !== 'object' ||
        typeof body.fileDecisions !== 'object'
      ) {
        throw new HttpBadRequestError('Invalid request');
      }
      await reviewDecisionStore.save(body.teamName, body.scopeKey, {
        hunkDecisions: body.hunkDecisions as never,
        fileDecisions: body.fileDecisions as never,
        hunkContextHashesByFile: body.hunkContextHashesByFile as never,
      });
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Error in POST /api/review/decisions:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/review/decisions', async (request, reply) => {
    try {
      const body = request.body as { teamName?: unknown; scopeKey?: unknown } | undefined;
      if (typeof body?.teamName !== 'string' || typeof body.scopeKey !== 'string') {
        throw new HttpBadRequestError('teamName and scopeKey are required');
      }
      await reviewDecisionStore.clear(body.teamName, body.scopeKey);
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Error in DELETE /api/review/decisions:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
