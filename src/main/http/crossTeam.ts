import { createLogger } from '@shared/utils/logger';

import { isAgentActionMode } from '../services/team/actionModeInstructions';
import { validateTaskId, validateTeamName } from '../ipc/guards';

import type { HttpServices } from './index';
import type { CrossTeamSendRequest, TaskRef } from '@shared/types';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:crossTeam');

class HttpBadRequestError extends Error {}
class HttpFeatureUnavailableError extends Error {}

function getService(services: HttpServices) {
  if (!services.crossTeamService) {
    throw new HttpFeatureUnavailableError('Cross-team communication is not available in this mode');
  }
  return services.crossTeamService;
}

function getStatusCode(error: unknown, fallback = 500): number {
  if (error instanceof HttpBadRequestError) return 400;
  if (error instanceof HttpFeatureUnavailableError) return 501;
  return fallback;
}

function validateTaskRefs(value: unknown): TaskRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new HttpBadRequestError('taskRefs must be an array');
  }

  const refs: TaskRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      throw new HttpBadRequestError('taskRefs entries must be objects');
    }
    const row = entry as Partial<TaskRef>;
    const taskId = typeof row.taskId === 'string' ? row.taskId.trim() : '';
    const displayId = typeof row.displayId === 'string' ? row.displayId.trim() : '';
    const teamName = typeof row.teamName === 'string' ? row.teamName.trim() : '';
    if (!taskId || !displayId || !teamName) {
      throw new HttpBadRequestError('Each taskRef must include taskId, displayId, and teamName');
    }

    const vTaskId = validateTaskId(taskId);
    if (!vTaskId.valid) {
      throw new HttpBadRequestError(vTaskId.error ?? 'Invalid taskRef taskId');
    }
    const vTeamName = validateTeamName(teamName);
    if (!vTeamName.valid) {
      throw new HttpBadRequestError(vTeamName.error ?? 'Invalid taskRef teamName');
    }

    refs.push({ taskId: vTaskId.value!, displayId, teamName: vTeamName.value! });
  }

  return refs;
}

function parseSendRequest(body: unknown): CrossTeamSendRequest {
  if (!body || typeof body !== 'object') {
    throw new HttpBadRequestError('Invalid request');
  }
  const req = body as Record<string, unknown>;
  const fromTeam = typeof req.fromTeam === 'string' ? req.fromTeam.trim() : '';
  const fromMember = typeof req.fromMember === 'string' ? req.fromMember.trim() : '';
  const toTeam = typeof req.toTeam === 'string' ? req.toTeam.trim() : '';
  const text = typeof req.text === 'string' ? req.text.trim() : '';
  if (!fromTeam) throw new HttpBadRequestError('fromTeam is required');
  if (!fromMember) throw new HttpBadRequestError('fromMember is required');
  if (!toTeam) throw new HttpBadRequestError('toTeam is required');
  if (!text) throw new HttpBadRequestError('text is required');

  if (req.actionMode !== undefined && !isAgentActionMode(req.actionMode)) {
    throw new HttpBadRequestError('actionMode must be one of: do, ask, delegate');
  }

  return {
    fromTeam,
    fromMember,
    toTeam,
    text,
    ...(typeof req.timestamp === 'string' && req.timestamp.trim()
      ? { timestamp: req.timestamp }
      : {}),
    ...(typeof req.messageId === 'string' && req.messageId.trim()
      ? { messageId: req.messageId }
      : {}),
    ...(typeof req.conversationId === 'string' && req.conversationId.trim()
      ? { conversationId: req.conversationId }
      : {}),
    ...(typeof req.replyToConversationId === 'string' && req.replyToConversationId.trim()
      ? { replyToConversationId: req.replyToConversationId }
      : {}),
    ...(validateTaskRefs(req.taskRefs) ? { taskRefs: validateTaskRefs(req.taskRefs) } : {}),
    ...(isAgentActionMode(req.actionMode) ? { actionMode: req.actionMode } : {}),
    ...(typeof req.summary === 'string' && req.summary.trim() ? { summary: req.summary } : {}),
    ...(typeof req.chainDepth === 'number' && Number.isFinite(req.chainDepth)
      ? { chainDepth: req.chainDepth }
      : {}),
  };
}

export function registerCrossTeamRoutes(app: FastifyInstance, services: HttpServices): void {
  app.get('/api/cross-team/targets', async (request, reply) => {
    try {
      const excludeTeam =
        typeof request.query === 'object' && request.query && 'excludeTeam' in request.query
          ? (request.query as { excludeTeam?: unknown }).excludeTeam
          : undefined;
      const result = await getService(services).listAvailableTargets(
        typeof excludeTeam === 'string' && excludeTeam.trim() ? excludeTeam.trim() : undefined
      );
      return reply.send(result);
    } catch (error) {
      logger.error('Error in GET /api/cross-team/targets:', error);
      return reply
        .status(getStatusCode(error))
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { teamName: string } }>(
    '/api/cross-team/:teamName/outbox',
    async (request, reply) => {
      try {
        const validated = validateTeamName(request.params.teamName);
        if (!validated.valid) {
          return reply.status(400).send({ error: validated.error ?? 'Invalid teamName' });
        }
        return reply.send(await getService(services).getOutbox(validated.value!));
      } catch (error) {
        logger.error(`Error in GET /api/cross-team/${request.params.teamName}/outbox:`, error);
        return reply
          .status(getStatusCode(error))
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  );

  app.post('/api/cross-team/send', async (request, reply) => {
    try {
      return reply.send(await getService(services).send(parseSendRequest(request.body)));
    } catch (error) {
      const status = getStatusCode(error);
      logger.error('Error in POST /api/cross-team/send:', error);
      return reply
        .status(status)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
