import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { isPathWithinRoot } from '@main/utils/pathValidation';
import { createLogger } from '@shared/utils/logger';
import fs from 'fs/promises';
import path from 'path';

import {
  EditorFileWatcher,
  FileSearchService,
  GitStatusService,
  ProjectFileService,
} from '../services/editor';
import type { HttpServices } from './index';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:editor');

class HttpBadRequestError extends Error {}
class HttpFeatureUnavailableError extends Error {}

let activeProjectRoot: string | null = null;
const fileWatcher = new EditorFileWatcher();

function getProjectFileService(services: HttpServices): ProjectFileService {
  if (!services.projectFileService) {
    throw new HttpFeatureUnavailableError('Editor file operations are not available in this mode');
  }
  return services.projectFileService;
}

function getFileSearchService(services: HttpServices): FileSearchService {
  if (!services.fileSearchService) {
    throw new HttpFeatureUnavailableError('Editor search is not available in this mode');
  }
  return services.fileSearchService;
}

function getGitStatusService(services: HttpServices): GitStatusService {
  if (!services.gitStatusService) {
    throw new HttpFeatureUnavailableError('Editor git status is not available in this mode');
  }
  return services.gitStatusService;
}

function getStatusCode(error: unknown, fallback = 500): number {
  if (error instanceof HttpBadRequestError) return 400;
  if (error instanceof HttpFeatureUnavailableError) return 501;
  return fallback;
}

function normalizeProjectPath(projectPath: unknown): string {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    throw new HttpBadRequestError('projectPath must be a non-empty string');
  }
  const normalized = path.resolve(projectPath.trim());
  if (normalized === '/' || /^[A-Z]:\\$/i.test(normalized)) {
    throw new HttpBadRequestError('Project path must not be a filesystem root');
  }
  return normalized;
}

function requireActiveProject(): string {
  if (!activeProjectRoot) {
    throw new HttpBadRequestError('Editor is not initialized');
  }
  return activeProjectRoot;
}

function startWatcher(services: HttpServices, projectRoot: string): void {
  fileWatcher.start(projectRoot, (event) => {
    services.eventBroadcaster?.('editor:change', event);
  });
}

function stopWatcher(): void {
  fileWatcher.stop();
}

export function registerEditorRoutes(app: FastifyInstance, services: HttpServices): void {
  app.post('/api/editor/open', async (request, reply) => {
    try {
      const body = request.body as { projectPath?: unknown } | undefined;
      const projectPath = normalizeProjectPath(body?.projectPath);
      if (isPathWithinRoot(projectPath, getClaudeBasePath())) {
        throw new HttpBadRequestError('Cannot open Claude data directory as project');
      }
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) {
        throw new HttpBadRequestError('Project path is not a directory');
      }

      activeProjectRoot = projectPath;
      getGitStatusService(services).init(projectPath);
      startWatcher(services, projectPath);
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Error in POST /api/editor/open:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/close', async (_request, reply) => {
    try {
      stopWatcher();
      getGitStatusService(services).destroy();
      activeProjectRoot = null;
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Error in POST /api/editor/close:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/editor/read-dir', async (request, reply) => {
    try {
      const query = request.query as { dirPath?: unknown; maxEntries?: unknown } | undefined;
      const projectRoot = requireActiveProject();
      const dirPath =
        typeof query?.dirPath === 'string' && query.dirPath.trim().length > 0
          ? path.resolve(query.dirPath.trim())
          : projectRoot;
      const maxEntries = typeof query?.maxEntries === 'number' ? query.maxEntries : undefined;
      return reply.send(
        await getProjectFileService(services).readDir(projectRoot, dirPath, maxEntries)
      );
    } catch (error) {
      logger.error('Error in GET /api/editor/read-dir:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/editor/read-file', async (request, reply) => {
    try {
      const query = request.query as { filePath?: unknown } | undefined;
      if (typeof query?.filePath !== 'string' || query.filePath.trim().length === 0) {
        throw new HttpBadRequestError('filePath is required');
      }
      const projectRoot = requireActiveProject();
      return reply.send(
        await getProjectFileService(services).readFile(projectRoot, query.filePath.trim())
      );
    } catch (error) {
      logger.error('Error in GET /api/editor/read-file:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/write-file', async (request, reply) => {
    try {
      const body = request.body as
        | { filePath?: unknown; content?: unknown; baselineMtimeMs?: unknown }
        | undefined;
      if (typeof body?.filePath !== 'string' || typeof body?.content !== 'string') {
        throw new HttpBadRequestError('filePath and content are required');
      }
      const projectRoot = requireActiveProject();
      return reply.send(
        await getProjectFileService(services).writeFile(projectRoot, body.filePath, body.content)
      );
    } catch (error) {
      logger.error('Error in POST /api/editor/write-file:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/create-file', async (request, reply) => {
    try {
      const body = request.body as { parentDir?: unknown; fileName?: unknown } | undefined;
      if (typeof body?.parentDir !== 'string' || typeof body?.fileName !== 'string') {
        throw new HttpBadRequestError('parentDir and fileName are required');
      }
      const projectRoot = requireActiveProject();
      return reply.send(
        await getProjectFileService(services).createFile(projectRoot, body.parentDir, body.fileName)
      );
    } catch (error) {
      logger.error('Error in POST /api/editor/create-file:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/create-dir', async (request, reply) => {
    try {
      const body = request.body as { parentDir?: unknown; dirName?: unknown } | undefined;
      if (typeof body?.parentDir !== 'string' || typeof body?.dirName !== 'string') {
        throw new HttpBadRequestError('parentDir and dirName are required');
      }
      const projectRoot = requireActiveProject();
      return reply.send(
        await getProjectFileService(services).createDir(projectRoot, body.parentDir, body.dirName)
      );
    } catch (error) {
      logger.error('Error in POST /api/editor/create-dir:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/delete-file', async (request, reply) => {
    try {
      const body = request.body as { filePath?: unknown } | undefined;
      if (typeof body?.filePath !== 'string') throw new HttpBadRequestError('filePath is required');
      const projectRoot = requireActiveProject();
      return reply.send(
        await getProjectFileService(services).deleteFile(projectRoot, body.filePath)
      );
    } catch (error) {
      logger.error('Error in POST /api/editor/delete-file:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/move-file', async (request, reply) => {
    try {
      const body = request.body as { sourcePath?: unknown; destDir?: unknown } | undefined;
      if (typeof body?.sourcePath !== 'string' || typeof body?.destDir !== 'string') {
        throw new HttpBadRequestError('sourcePath and destDir are required');
      }
      const projectRoot = requireActiveProject();
      return reply.send(
        await getProjectFileService(services).moveFile(projectRoot, body.sourcePath, body.destDir)
      );
    } catch (error) {
      logger.error('Error in POST /api/editor/move-file:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/rename-file', async (request, reply) => {
    try {
      const body = request.body as { sourcePath?: unknown; newName?: unknown } | undefined;
      if (typeof body?.sourcePath !== 'string' || typeof body?.newName !== 'string') {
        throw new HttpBadRequestError('sourcePath and newName are required');
      }
      const projectRoot = requireActiveProject();
      return reply.send(
        await getProjectFileService(services).renameFile(projectRoot, body.sourcePath, body.newName)
      );
    } catch (error) {
      logger.error('Error in POST /api/editor/rename-file:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/search-in-files', async (request, reply) => {
    try {
      const body = request.body as
        | { query?: unknown; caseSensitive?: unknown; maxFiles?: unknown; maxMatches?: unknown }
        | undefined;
      if (typeof body?.query !== 'string') {
        throw new HttpBadRequestError('query is required');
      }
      const projectRoot = requireActiveProject();
      return reply.send(
        await getFileSearchService(services).searchInFiles(projectRoot, {
          query: body.query,
          caseSensitive: body.caseSensitive === true,
          ...(typeof body.maxFiles === 'number' ? { maxFiles: body.maxFiles } : {}),
          ...(typeof body.maxMatches === 'number' ? { maxMatches: body.maxMatches } : {}),
        })
      );
    } catch (error) {
      logger.error('Error in POST /api/editor/search-in-files:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/editor/list-files', async (request, reply) => {
    try {
      const query = request.query as { projectPath?: unknown } | undefined;
      const projectRoot = normalizeProjectPath(query?.projectPath ?? requireActiveProject());
      return reply.send(await getFileSearchService(services).listFiles(projectRoot));
    } catch (error) {
      logger.error('Error in GET /api/editor/list-files:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/project/list-files', async (request, reply) => {
    try {
      const query = request.query as { projectPath?: unknown } | undefined;
      const projectRoot = normalizeProjectPath(query?.projectPath ?? requireActiveProject());
      return reply.send(await getFileSearchService(services).listFiles(projectRoot));
    } catch (error) {
      logger.error('Error in GET /api/project/list-files:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/editor/read-binary-preview', async (request, reply) => {
    try {
      const query = request.query as { filePath?: unknown } | undefined;
      if (typeof query?.filePath !== 'string')
        throw new HttpBadRequestError('filePath is required');
      const projectRoot = requireActiveProject();
      return reply.send(
        await getProjectFileService(services).readBinaryPreview(projectRoot, query.filePath)
      );
    } catch (error) {
      logger.error('Error in GET /api/editor/read-binary-preview:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/editor/git-status', async (_request, reply) => {
    try {
      return reply.send(await getGitStatusService(services).getStatus());
    } catch (error) {
      logger.error('Error in GET /api/editor/git-status:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/watch-dir', async (request, reply) => {
    try {
      const body = request.body as { enable?: unknown } | undefined;
      if (body?.enable === false) {
        stopWatcher();
        return reply.send({ success: true });
      }
      if (!activeProjectRoot) throw new HttpBadRequestError('Editor is not initialized');
      startWatcher(services, activeProjectRoot);
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Error in POST /api/editor/watch-dir:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/set-watched-files', async (request, reply) => {
    try {
      const body = request.body as { filePaths?: unknown } | undefined;
      if (!Array.isArray(body?.filePaths))
        throw new HttpBadRequestError('filePaths must be an array');
      fileWatcher.setWatchedFiles(
        body.filePaths.filter((item): item is string => typeof item === 'string')
      );
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Error in POST /api/editor/set-watched-files:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/editor/set-watched-dirs', async (request, reply) => {
    try {
      const body = request.body as { dirPaths?: unknown } | undefined;
      if (!Array.isArray(body?.dirPaths))
        throw new HttpBadRequestError('dirPaths must be an array');
      fileWatcher.setWatchedDirs(
        body.dirPaths.filter((item): item is string => typeof item === 'string')
      );
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Error in POST /api/editor/set-watched-dirs:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
