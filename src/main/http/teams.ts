import { validateTeamName } from '@main/ipc/guards';
import { gitIdentityResolver } from '@main/services/parsing/GitIdentityResolver';
import { TeamAttachmentStore, TeamMembersMetaStore } from '@main/services/team';
import { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';
import { MemberStatsComputer } from '@main/services/team/MemberStatsComputer';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { TeamTaskAttachmentStore } from '@main/services/team/TeamTaskAttachmentStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import {
  PROTECTED_CLI_FLAGS,
  extractFlagsFromHelp,
  extractUserFlags,
} from '@shared/utils/cliArgsParser';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { isAbsolute } from 'path';
import * as fs from 'fs';
import * as path from 'path';

import type { HttpServices } from './index';
import type {
  EffortLevel,
  TeamLaunchRequest,
  TeamCreateRequest,
  TeamCreateConfigRequest,
} from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:teams');
const attachmentStore = new TeamAttachmentStore();
const taskAttachmentStore = new TeamTaskAttachmentStore();
const teamMetaStore = new TeamMetaStore();
const membersMetaStore = new TeamMembersMetaStore();
const teamMemberLogsFinder = new TeamMemberLogsFinder();
const memberStatsComputer = new MemberStatsComputer(teamMemberLogsFinder);

type LaunchBody = Omit<TeamLaunchRequest, 'teamName'>;

const EFFORT_LEVELS = new Set<EffortLevel>(['low', 'medium', 'high']);

class HttpBadRequestError extends Error {}
class HttpFeatureUnavailableError extends Error {}

function getTeamProvisioningService(services: HttpServices) {
  if (!services.teamProvisioningService) {
    throw new HttpFeatureUnavailableError('Team runtime control is not available in this mode');
  }
  return services.teamProvisioningService;
}

function getTeamDataService(services: HttpServices) {
  if (!services.teamDataService) {
    throw new HttpFeatureUnavailableError('Team data is not available in this mode');
  }
  return services.teamDataService;
}

function getTeamMemberLogsFinder(services: HttpServices) {
  return services.teamMemberLogsFinder ?? teamMemberLogsFinder;
}

function getMemberStatsComputer(services: HttpServices) {
  return services.memberStatsComputer ?? memberStatsComputer;
}

function getTeamBackupService(services: HttpServices) {
  return services.teamBackupService ?? null;
}

function getStatusCode(error: unknown, fallback: number = 500): number {
  if (error instanceof HttpBadRequestError) {
    return 400;
  }
  if (error instanceof HttpFeatureUnavailableError) {
    return 501;
  }
  return fallback;
}

function shouldLogError(error: unknown): boolean {
  return !(error instanceof HttpBadRequestError) && !(error instanceof HttpFeatureUnavailableError);
}

function assertAbsoluteCwd(cwd: unknown): string {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw new HttpBadRequestError('cwd must be a non-empty string');
  }

  const normalized = cwd.trim();
  if (!isAbsolute(normalized)) {
    throw new HttpBadRequestError('cwd must be an absolute path');
  }

  return normalized;
}

function assertOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new HttpBadRequestError(`${fieldName} must be a string`);
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function assertOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new HttpBadRequestError(`${fieldName} must be a boolean`);
  }

  return value;
}

function assertOptionalEffort(value: unknown): EffortLevel | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'string' || !EFFORT_LEVELS.has(value as EffortLevel)) {
    throw new HttpBadRequestError('effort must be one of: low, medium, high');
  }

  return value as EffortLevel;
}

function parseLaunchRequest(teamName: string, body: unknown): TeamLaunchRequest {
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const prompt = assertOptionalString(payload.prompt, 'prompt');
  const model = assertOptionalString(payload.model, 'model');
  const effort = assertOptionalEffort(payload.effort);
  const clearContext = assertOptionalBoolean(payload.clearContext, 'clearContext');
  const skipPermissions = assertOptionalBoolean(payload.skipPermissions, 'skipPermissions');
  const worktree = assertOptionalString(payload.worktree, 'worktree');
  const extraCliArgs = assertOptionalString(payload.extraCliArgs, 'extraCliArgs');

  return {
    teamName,
    cwd: assertAbsoluteCwd(payload.cwd),
    ...(prompt && {
      prompt,
    }),
    ...(model && {
      model,
    }),
    ...(effort && {
      effort,
    }),
    ...(clearContext !== undefined && {
      clearContext,
    }),
    ...(skipPermissions !== undefined && {
      skipPermissions,
    }),
    ...(worktree && {
      worktree,
    }),
    ...(extraCliArgs && {
      extraCliArgs,
    }),
  };
}

export function registerTeamRoutes(app: FastifyInstance, services: HttpServices): void {
  app.post<{ Params: { teamName: string }; Body: LaunchBody }>(
    '/api/teams/:teamName/launch',
    async (request, reply) => {
      try {
        const params = request.params as { teamName?: unknown };
        const validatedTeamName = validateTeamName(params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }

        const launchRequest = parseLaunchRequest(validatedTeamName.value!, request.body);
        const response = await getTeamProvisioningService(services).launchTeam(
          launchRequest,
          () => undefined
        );
        return reply.send(response);
      } catch (error) {
        const statusCode = getStatusCode(error);
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${String((request.params as { teamName?: unknown }).teamName)}/launch:`,
            getErrorMessage(error)
          );
        }
        return reply.status(statusCode).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.post<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/stop',
    async (request, reply) => {
      try {
        const params = request.params as { teamName?: unknown };
        const validatedTeamName = validateTeamName(params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }

        const teamProvisioningService = getTeamProvisioningService(services);
        teamProvisioningService.stopTeam(validatedTeamName.value!);
        return reply.send(teamProvisioningService.getRuntimeState(validatedTeamName.value!));
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in POST /api/teams/${String((request.params as { teamName?: unknown }).teamName)}/stop:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.get<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/runtime',
    async (request, reply) => {
      try {
        const params = request.params as { teamName?: unknown };
        const validatedTeamName = validateTeamName(params.teamName);
        if (!validatedTeamName.valid) {
          return reply.status(400).send({ error: validatedTeamName.error });
        }

        return reply.send(
          getTeamProvisioningService(services).getRuntimeState(validatedTeamName.value!)
        );
      } catch (error) {
        if (shouldLogError(error)) {
          logger.error(
            `Error in GET /api/teams/${String((request.params as { teamName?: unknown }).teamName)}/runtime:`,
            getErrorMessage(error)
          );
        }
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.get<{ Params: { runId: string } }>(
    '/api/teams/provisioning/:runId',
    async (request, reply) => {
      try {
        const params = request.params as { runId?: unknown };
        const runId = typeof params.runId === 'string' ? params.runId.trim() : '';
        if (!runId) {
          return reply.status(400).send({ error: 'runId is required' });
        }

        return reply.send(await getTeamProvisioningService(services).getProvisioningStatus(runId));
      } catch (error) {
        const message = getErrorMessage(error);
        const statusCode = message === 'Unknown runId' ? 404 : getStatusCode(error);
        if (shouldLogError(error) && statusCode !== 404) {
          logger.error(
            `Error in GET /api/teams/provisioning/${String((request.params as { runId?: unknown }).runId)}:`,
            message
          );
        }
        return reply.status(statusCode).send({ error: message });
      }
    }
  );

  app.post<{ Params: { runId: string } }>(
    '/api/teams/provisioning/:runId/cancel',
    async (request, reply) => {
      try {
        const params = request.params as { runId?: unknown };
        const runId = typeof params.runId === 'string' ? params.runId.trim() : '';
        if (!runId) {
          return reply.status(400).send({ error: 'runId is required' });
        }
        await getTeamProvisioningService(services).cancelProvisioning(runId);
        return reply.send({ success: true });
      } catch (error) {
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.get('/api/teams/runtime/alive', async (_request, reply) => {
    try {
      const teamProvisioningService = getTeamProvisioningService(services);
      const runtimeStates = teamProvisioningService
        .getAliveTeams()
        .map((teamName) => teamProvisioningService.getRuntimeState(teamName));
      return reply.send(runtimeStates);
    } catch (error) {
      if (shouldLogError(error)) {
        logger.error('Error in GET /api/teams/runtime/alive:', getErrorMessage(error));
      }
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  registerTeamFeatureRoutes(app, services);
}

function registerTeamFeatureRoutes(app: FastifyInstance, services: HttpServices): void {
  const requireTeamName = (value: unknown, fieldName = 'teamName'): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new HttpBadRequestError(`${fieldName} must be a non-empty string`);
    }
    const validated = validateTeamName(value);
    if (!validated.valid) {
      throw new HttpBadRequestError(validated.error ?? `Invalid ${fieldName}`);
    }
    return validated.value!;
  };

  const requireString = (value: unknown, fieldName: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new HttpBadRequestError(`${fieldName} must be a non-empty string`);
    }
    return value.trim();
  };

  const requireOptionalString = (value: unknown): string | undefined => {
    if (value == null) return undefined;
    if (typeof value !== 'string') {
      throw new HttpBadRequestError('Expected string');
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  };

  const parseIntervals = (
    value: unknown
  ): { startedAt: string; completedAt?: string }[] | undefined => {
    if (Array.isArray(value)) {
      return value.filter(
        (entry): entry is { startedAt: string; completedAt?: string } =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).startedAt === 'string' &&
          ((entry as Record<string, unknown>).completedAt === undefined ||
            typeof (entry as Record<string, unknown>).completedAt === 'string')
      );
    }
    if (typeof value !== 'string' || value.trim().length === 0) return undefined;
    try {
      return parseIntervals(JSON.parse(value));
    } catch {
      return undefined;
    }
  };

  const progressResponder =
    (teamName: string) =>
    (progress: unknown): void => {
      services.eventBroadcaster?.('team:provisioningProgress', progress);
      logger.info(`[${teamName}] progress ${JSON.stringify(progress)}`);
    };

  const enrichTeamDataWithRuntimeState = <
    TData extends {
      config: { name?: string; projectPath?: string };
      messages: Array<{
        messageId?: string;
        timestamp: string;
        from: string;
        text: string;
        to?: string;
        source?: string;
        leadSessionId?: string;
      }>;
    },
  >(
    teamName: string,
    data: TData
  ): TData & { isAlive: boolean } => {
    const provisioning = services.teamProvisioningService;
    if (!provisioning) {
      return { ...data, isAlive: false };
    }

    const isAlive = provisioning.isTeamAlive(teamName);
    const displayName = data.config.name || teamName;
    const projectPath = data.config.projectPath;
    const live = provisioning.getLiveLeadProcessMessages(teamName);

    if (live.length === 0) {
      return { ...data, isAlive };
    }

    const normalizeText = (text: string): string => text.trim().replace(/\r\n/g, '\n');
    const isLeadThoughtLike = (msg: { source?: unknown; to?: string }): boolean =>
      !msg.to && (msg.source === 'lead_process' || msg.source === 'lead_session');
    const getLeadThoughtFingerprint = (msg: {
      from: string;
      text: string;
      leadSessionId?: string;
    }): string => `${msg.leadSessionId ?? ''}\0${msg.from}\0${normalizeText(msg.text)}`;

    const existingTextFingerprints = new Set<string>();
    for (const msg of data.messages) {
      if (typeof msg.from !== 'string' || typeof msg.text !== 'string') continue;
      if (!isLeadThoughtLike(msg)) continue;
      existingTextFingerprints.add(getLeadThoughtFingerprint(msg));
    }

    const keyFor = (msg: {
      messageId?: string;
      timestamp: string;
      from: string;
      text: string;
    }): string => {
      if (typeof msg.messageId === 'string' && msg.messageId.trim().length > 0) {
        return msg.messageId;
      }
      return `${msg.timestamp}\0${msg.from}\0${(msg.text ?? '').slice(0, 80)}`;
    };

    const leadProcessTextFingerprints = new Set<string>();
    const contentSeen = new Map<string, number>();
    const merged: typeof data.messages = [];
    const seen = new Set<string>();

    for (const msg of [...data.messages, ...live]) {
      if ((msg as { source?: unknown }).source === 'lead_process' && !msg.to) {
        const fingerprint = getLeadThoughtFingerprint(msg);
        if (existingTextFingerprints.has(fingerprint)) {
          continue;
        }
        if (leadProcessTextFingerprints.has(fingerprint)) {
          continue;
        }
        leadProcessTextFingerprints.add(fingerprint);
      }

      if (typeof msg.to === 'string' && msg.to.trim().length > 0) {
        const contentFingerprint = `${msg.from}\0${msg.to}\0${(msg.text ?? '').replace(/\s+/g, ' ').slice(0, 100)}`;
        const msgMs = Date.parse(msg.timestamp);
        const existingMs = contentSeen.get(contentFingerprint);
        if (existingMs !== undefined && Math.abs(msgMs - existingMs) <= 5000) {
          continue;
        }
        contentSeen.set(contentFingerprint, msgMs);
      }

      const key = keyFor(msg);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(msg);
    }

    merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return { ...data, isAlive, messages: merged };
  };

  app.get('/api/teams', async (_request, reply) => {
    try {
      return reply.send(await getTeamDataService(services).listTeams());
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get<{ Params: { teamName: string } }>('/api/teams/:teamName', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      const teamName = requireTeamName(params.teamName);
      try {
        const data = await getTeamDataService(services).getTeamData(teamName);
        return reply.send(enrichTeamDataWithRuntimeState(teamName, data));
      } catch (error) {
        const message = getErrorMessage(error);
        if (message === `Team not found: ${teamName}`) {
          if (services.teamProvisioningService?.hasProvisioningRun(teamName)) {
            return reply.status(409).send({ error: 'TEAM_PROVISIONING' });
          }
          const meta = await teamMetaStore.getMeta(teamName);
          if (meta) {
            return reply.status(409).send({ error: 'TEAM_DRAFT' });
          }
        }
        throw error;
      }
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get<{ Params: { teamName: string } }>('/api/teams/:teamName/logs', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      const teamName = requireTeamName(params.teamName);
      const query = request.query as { offset?: unknown; limit?: unknown };
      const offset = typeof query.offset === 'number' ? query.offset : Number(query.offset ?? 0);
      const limit = typeof query.limit === 'number' ? query.limit : Number(query.limit ?? 100);
      return reply.send(
        getTeamProvisioningService(services).getClaudeLogs(teamName, { offset, limit })
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/saved-request',
    async (request, reply) => {
      try {
        const params = request.params as { teamName?: unknown };
        const teamName = requireTeamName(params.teamName);
        const meta = await teamMetaStore.getMeta(teamName);
        if (!meta) return reply.send(null);
        const members = await membersMetaStore.getMembers(teamName);
        return reply.send({
          teamName,
          displayName: meta.displayName,
          description: meta.description,
          color: meta.color,
          cwd: meta.cwd,
          prompt: meta.prompt,
          model: meta.model,
          effort: meta.effort as EffortLevel | undefined,
          skipPermissions: meta.skipPermissions,
          worktree: meta.worktree,
          extraCliArgs: meta.extraCliArgs,
          limitContext: meta.limitContext,
          members: members.map((member) => ({
            name: member.name,
            role: member.role,
            workflow: member.workflow,
          })),
        } satisfies TeamCreateRequest);
      } catch (error) {
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.delete<{ Params: { teamName: string } }>('/api/teams/:teamName', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      const teamName = requireTeamName(params.teamName);
      getTeamProvisioningService(services).stopTeam(teamName);
      await getTeamDataService(services).deleteTeam(teamName);
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/restore',
    async (request, reply) => {
      try {
        const params = request.params as { teamName?: unknown };
        const teamName = requireTeamName(params.teamName);
        await getTeamDataService(services).restoreTeam(teamName);
        return reply.send({ success: true });
      } catch (error) {
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.delete<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/permanent',
    async (request, reply) => {
      try {
        const params = request.params as { teamName?: unknown };
        const teamName = requireTeamName(params.teamName);
        await getTeamDataService(services).permanentlyDeleteTeam(teamName);
        await getTeamBackupService(services)?.markDeletedByUser(teamName);
        return reply.send({ success: true });
      } catch (error) {
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.delete<{ Params: { teamName: string } }>(
    '/api/teams/:teamName/draft',
    async (request, reply) => {
      try {
        const params = request.params as { teamName?: unknown };
        const teamName = requireTeamName(params.teamName);
        const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
        try {
          await fs.promises.access(configPath, fs.constants.F_OK);
          throw new HttpBadRequestError(
            'Cannot delete draft: team has config.json (use deleteTeam instead)'
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        await getTeamDataService(services).permanentlyDeleteTeam(teamName);
        return reply.send({ success: true });
      } catch (error) {
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.post('/api/teams/prepare-provisioning', async (request, reply) => {
    try {
      const body = request.body as { cwd?: unknown };
      const cwd = body.cwd == null ? undefined : requireString(body.cwd, 'cwd');
      return reply.send(await getTeamProvisioningService(services).prepareForProvisioning(cwd));
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams', async (request, reply) => {
    try {
      const createRequest = request.body as TeamCreateRequest;
      if (!createRequest || typeof createRequest !== 'object') {
        throw new HttpBadRequestError('Invalid team create request');
      }
      const response = await getTeamProvisioningService(services).createTeam(
        createRequest,
        progressResponder(createRequest.teamName)
      );
      return reply.send(response);
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/send-message', async (request, reply) => {
    try {
      const teamName = requireTeamName((request.params as { teamName?: unknown }).teamName);
      return reply.send(
        await getTeamDataService(services).sendMessage(teamName, request.body as any)
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/tasks', async (request, reply) => {
    try {
      const teamName = requireTeamName((request.params as { teamName?: unknown }).teamName);
      return reply.send(
        await getTeamDataService(services).createTask(teamName, request.body as any)
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/tasks/:taskId/request-review', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      await getTeamDataService(services).requestReview(
        requireTeamName(params.teamName),
        requireString(params.taskId, 'taskId')
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/tasks/:taskId/comments', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      const body = request.body as { text?: unknown; taskRefs?: unknown; attachments?: unknown };
      return reply.send(
        await getTeamDataService(services).addTaskComment(
          requireTeamName(params.teamName),
          requireString(params.taskId, 'taskId'),
          requireString(body.text, 'text'),
          Array.isArray(body.attachments) ? (body.attachments as any) : undefined,
          Array.isArray(body.taskRefs) ? (body.taskRefs as any) : undefined
        )
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.patch('/api/teams/:teamName/tasks/:taskId/kanban', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      await getTeamDataService(services).updateKanban(
        requireTeamName(params.teamName),
        requireString(params.taskId, 'taskId'),
        request.body as any
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.patch('/api/teams/:teamName/kanban/:columnId/order', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; columnId?: unknown };
      const body = request.body as { orderedTaskIds?: unknown };
      if (!Array.isArray(body.orderedTaskIds)) {
        throw new HttpBadRequestError('orderedTaskIds must be an array');
      }
      await getTeamDataService(services).updateKanbanColumnOrder(
        requireTeamName(params.teamName),
        requireString(params.columnId, 'columnId') as any,
        body.orderedTaskIds.filter((id): id is string => typeof id === 'string')
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.patch('/api/teams/:teamName/tasks/:taskId/status', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      const body = request.body as { status?: unknown };
      await getTeamDataService(services).updateTaskStatus(
        requireTeamName(params.teamName),
        requireString(params.taskId, 'taskId'),
        requireString(body.status, 'status') as any
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.patch('/api/teams/:teamName/tasks/:taskId/owner', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      const body = request.body as { owner?: unknown };
      await getTeamDataService(services).updateTaskOwner(
        requireTeamName(params.teamName),
        requireString(params.taskId, 'taskId'),
        typeof body.owner === 'string' ? body.owner : null
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.patch('/api/teams/:teamName/tasks/:taskId/fields', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      await getTeamDataService(services).updateTaskFields(
        requireTeamName(params.teamName),
        requireString(params.taskId, 'taskId'),
        request.body as any
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/tasks/:taskId/start', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      return reply.send(
        await getTeamDataService(services).startTask(
          requireTeamName(params.teamName),
          requireString(params.taskId, 'taskId')
        )
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/process/send', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      const body = request.body as { message?: unknown };
      await getTeamProvisioningService(services).sendMessageToTeam(
        requireTeamName(params.teamName),
        requireString(body.message, 'message')
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/:teamName/process/alive', async (request, reply) => {
    try {
      return reply.send(
        getTeamProvisioningService(services).isTeamAlive(
          requireTeamName((request.params as { teamName?: unknown }).teamName)
        )
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/alive-list', async (_request, reply) => {
    try {
      return reply.send(getTeamProvisioningService(services).getAliveTeams());
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/create-config', async (request, reply) => {
    try {
      await getTeamDataService(services).createTeamConfig(request.body as TeamCreateConfigRequest);
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/all-tasks', async (_request, reply) => {
    try {
      return reply.send(await getTeamDataService(services).getAllTasks());
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/:teamName/member-logs/:memberName', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; memberName?: unknown };
      return reply.send(
        await getTeamMemberLogsFinder(services).findMemberLogs(
          requireTeamName(params.teamName),
          requireString(params.memberName, 'memberName')
        )
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/:teamName/logs-for-task/:taskId', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      const query = request.query as {
        owner?: unknown;
        status?: unknown;
        since?: unknown;
        intervals?: unknown;
      };
      return reply.send(
        await getTeamMemberLogsFinder(services).findLogsForTask(
          requireTeamName(params.teamName),
          requireString(params.taskId, 'taskId'),
          {
            owner: requireOptionalString(query.owner),
            status: requireOptionalString(query.status),
            since: requireOptionalString(query.since),
            intervals: parseIntervals(query.intervals),
          }
        )
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/:teamName/member-stats/:memberName', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; memberName?: unknown };
      return reply.send(
        await getMemberStatsComputer(services).getStats(
          requireTeamName(params.teamName),
          requireString(params.memberName, 'memberName')
        )
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.patch('/api/teams/:teamName/config', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      return reply.send(
        await getTeamDataService(services).updateConfig(
          requireTeamName(params.teamName),
          request.body as any
        )
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/members', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      await getTeamDataService(services).addMember(
        requireTeamName(params.teamName),
        request.body as any
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.put('/api/teams/:teamName/members', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      await getTeamDataService(services).replaceMembers(
        requireTeamName(params.teamName),
        request.body as any
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.delete('/api/teams/:teamName/members/:memberName', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; memberName?: unknown };
      await getTeamDataService(services).removeMember(
        requireTeamName(params.teamName),
        requireString(params.memberName, 'memberName')
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.patch('/api/teams/:teamName/members/:memberName/role', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; memberName?: unknown };
      const body = request.body as { role?: unknown };
      return reply.send(
        await getTeamDataService(services).updateMemberRole(
          requireTeamName(params.teamName),
          requireString(params.memberName, 'memberName'),
          typeof body.role === 'string' ? body.role : undefined
        )
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/project-branch', async (request, reply) => {
    try {
      const query = request.query as { projectPath?: unknown } | undefined;
      if (typeof query?.projectPath !== 'string' || query.projectPath.trim().length === 0) {
        throw new HttpBadRequestError('projectPath is required');
      }
      const branch = await gitIdentityResolver.getBranch(
        path.normalize(path.resolve(query.projectPath))
      );
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .send(JSON.stringify(branch));
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/:teamName/project-branch', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      const teamName = requireTeamName(params.teamName);
      const data = await getTeamDataService(services).getTeamData(teamName);
      const projectPath = data.config.projectPath;
      const branch = projectPath
        ? await gitIdentityResolver.getBranch(path.normalize(projectPath))
        : null;
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .send(JSON.stringify(branch));
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/:teamName/attachments/:messageId', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; messageId?: unknown };
      return reply.send(
        await attachmentStore.getAttachments(
          requireTeamName(params.teamName),
          requireString(params.messageId, 'messageId')
        )
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/process/:pid/kill', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; pid?: unknown };
      const pid = typeof params.pid === 'number' ? params.pid : Number(params.pid);
      if (!Number.isFinite(pid)) throw new HttpBadRequestError('pid must be a number');
      await getTeamDataService(services).killProcess(requireTeamName(params.teamName), pid);
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/:teamName/lead-activity', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      return reply.send(
        getTeamProvisioningService(services).getLeadActivityState(requireTeamName(params.teamName))
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/:teamName/lead-context', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      return reply.send(
        getTeamProvisioningService(services).getLeadContextUsage(requireTeamName(params.teamName))
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/:teamName/member-spawn-statuses', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      return reply.send(
        getTeamProvisioningService(services).getMemberSpawnStatuses(
          requireTeamName(params.teamName)
        )
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/tasks/:taskId/soft-delete', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      await getTeamDataService(services).softDeleteTask(
        requireTeamName(params.teamName),
        requireString(params.taskId, 'taskId')
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/tasks/:taskId/restore', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      await getTeamDataService(services).restoreTask(
        requireTeamName(params.teamName),
        requireString(params.taskId, 'taskId')
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get('/api/teams/:teamName/tasks/deleted', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      return reply.send(
        await getTeamDataService(services).getDeletedTasks(requireTeamName(params.teamName))
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.patch('/api/teams/:teamName/tasks/:taskId/clarification', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      const body = request.body as { value?: unknown };
      await getTeamDataService(services).setTaskNeedsClarification(
        requireTeamName(params.teamName),
        requireString(params.taskId, 'taskId'),
        body.value === 'lead' || body.value === 'user' || body.value === null ? body.value : null
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/message-notification', async (request, reply) => {
    try {
      void request.body as any;
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/tasks/:taskId/relationships', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      const body = request.body as { targetId?: unknown; type?: unknown };
      await getTeamDataService(services).addTaskRelationship(
        requireTeamName(params.teamName),
        requireString(params.taskId, 'taskId'),
        requireString(body.targetId, 'targetId'),
        body.type === 'blockedBy' || body.type === 'blocks' || body.type === 'related'
          ? body.type
          : 'related'
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.delete(
    '/api/teams/:teamName/tasks/:taskId/relationships/:targetId',
    async (request, reply) => {
      try {
        const params = request.params as {
          teamName?: unknown;
          taskId?: unknown;
          targetId?: unknown;
        };
        const body = request.body as { type?: unknown };
        await getTeamDataService(services).removeTaskRelationship(
          requireTeamName(params.teamName),
          requireString(params.taskId, 'taskId'),
          requireString(params.targetId, 'targetId'),
          body.type === 'blockedBy' || body.type === 'blocks' || body.type === 'related'
            ? body.type
            : 'related'
        );
        return reply.send({ success: true });
      } catch (error) {
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.post('/api/teams/:teamName/tasks/:taskId/attachments', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown; taskId?: unknown };
      const body = request.body as {
        attachmentId?: unknown;
        filename?: unknown;
        mimeType?: unknown;
        base64Data?: unknown;
      };
      return reply.send(
        await (async () => {
          const meta = await taskAttachmentStore.saveAttachment(
            requireTeamName(params.teamName),
            requireString(params.taskId, 'taskId'),
            requireString(body.attachmentId, 'attachmentId'),
            requireString(body.filename, 'filename'),
            requireString(body.mimeType, 'mimeType'),
            requireString(body.base64Data, 'base64Data')
          );
          await getTeamDataService(services).addTaskAttachment(
            requireTeamName(params.teamName),
            requireString(params.taskId, 'taskId'),
            meta as any
          );
          return meta;
        })()
      );
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.get(
    '/api/teams/:teamName/tasks/:taskId/attachments/:attachmentId',
    async (request, reply) => {
      try {
        const params = request.params as {
          teamName?: unknown;
          taskId?: unknown;
          attachmentId?: unknown;
        };
        const body = request.query as { mimeType?: unknown };
        return reply.send(
          await taskAttachmentStore.getAttachment(
            requireTeamName(params.teamName),
            requireString(params.taskId, 'taskId'),
            requireString(params.attachmentId, 'attachmentId'),
            requireString(body.mimeType, 'mimeType')
          )
        );
      } catch (error) {
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.delete(
    '/api/teams/:teamName/tasks/:taskId/attachments/:attachmentId',
    async (request, reply) => {
      try {
        const params = request.params as {
          teamName?: unknown;
          taskId?: unknown;
          attachmentId?: unknown;
        };
        const body = request.query as { mimeType?: unknown };
        await taskAttachmentStore.deleteAttachment(
          requireTeamName(params.teamName),
          requireString(params.taskId, 'taskId'),
          requireString(params.attachmentId, 'attachmentId'),
          requireString(body.mimeType, 'mimeType')
        );
        await getTeamDataService(services).removeTaskAttachment(
          requireTeamName(params.teamName),
          requireString(params.taskId, 'taskId'),
          requireString(params.attachmentId, 'attachmentId')
        );
        return reply.send({ success: true });
      } catch (error) {
        return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
      }
    }
  );

  app.post('/api/teams/:teamName/tool-approval/respond', async (request, reply) => {
    try {
      const params = request.params as { teamName?: unknown };
      const body = request.body as {
        runId?: unknown;
        requestId?: unknown;
        allow?: unknown;
        message?: unknown;
      };
      if (typeof body.allow !== 'boolean') {
        throw new HttpBadRequestError('allow must be a boolean');
      }
      await getTeamProvisioningService(services).respondToToolApproval(
        requireTeamName(params.teamName),
        requireString(body.runId, 'runId'),
        requireString(body.requestId, 'requestId'),
        body.allow,
        requireOptionalString(body.message)
      );
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/tool-approval/validate-cli-args', async (request, reply) => {
    try {
      const body = request.body as { rawArgs?: unknown };
      const rawArgs = requireString(body.rawArgs, 'rawArgs');
      if (rawArgs.length > 2048) {
        throw new HttpBadRequestError('rawArgs too long (max 2048)');
      }
      const helpOutput = await getTeamProvisioningService(services).getCliHelpOutput();
      const knownFlags = extractFlagsFromHelp(helpOutput);
      const userFlags = extractUserFlags(rawArgs);
      const invalidFlags = userFlags.filter((flag) => !knownFlags.has(flag));
      const protectedFlags = userFlags.filter((flag) => PROTECTED_CLI_FLAGS.has(flag));
      const allBad = [...new Set([...invalidFlags, ...protectedFlags])];
      return reply.send({
        valid: allBad.length === 0,
        invalidFlags: allBad.length > 0 ? allBad : undefined,
      });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.patch('/api/teams/tool-approval/settings', async (request, reply) => {
    try {
      getTeamProvisioningService(services).updateToolApprovalSettings(request.body as any);
      return reply.send({ success: true });
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/tool-approval/read-file', async (request, reply) => {
    try {
      const body = request.body as { filePath?: unknown };
      const filePath = requireString(body.filePath, 'filePath');
      if (!path.isAbsolute(filePath)) {
        throw new HttpBadRequestError('filePath must be an absolute path');
      }

      try {
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile()) {
          return reply.send({
            content: '',
            exists: true,
            truncated: false,
            isBinary: false,
            error: 'Not a file',
          });
        }
        const truncated = stats.size > 2 * 1024 * 1024;
        const readSize = truncated ? 2 * 1024 * 1024 : stats.size;
        const fd = await fs.promises.open(filePath, 'r');
        try {
          const buffer = Buffer.alloc(readSize);
          await fd.read(buffer, 0, readSize, 0);
          const checkSize = Math.min(readSize, 8192);
          for (let i = 0; i < checkSize; i++) {
            if (buffer[i] === 0) {
              return reply.send({ content: '', exists: true, truncated: false, isBinary: true });
            }
          }
          return reply.send({
            content: buffer.toString('utf8'),
            exists: true,
            truncated,
            isBinary: false,
          });
        } finally {
          await fd.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.send({ content: '', exists: false, truncated: false, isBinary: false });
        }
        throw error;
      }
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });

  app.post('/api/teams/:teamName/show-message-notification', async (_request, reply) => {
    return reply.send({ success: true });
  });

  app.get('/api/teams/:teamName/summary', async (request, reply) => {
    try {
      const teamName = requireTeamName((request.params as { teamName?: unknown }).teamName);
      const data = await getTeamDataService(services).getTeamData(teamName);
      return reply.send(enrichTeamDataWithRuntimeState(teamName, data));
    } catch (error) {
      return reply.status(getStatusCode(error)).send({ error: getErrorMessage(error) });
    }
  });
}
