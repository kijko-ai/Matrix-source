import Fastify from 'fastify';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { registerTeamRoutes } from '@main/http/teams';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import type { HttpServices } from '@main/http';
import type {
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types/team';

describe('HTTP team runtime routes', () => {
  function createServicesMock() {
    const launchTeam = vi.fn<
      (request: TeamLaunchRequest, onProgress: (progress: TeamProvisioningProgress) => void) => Promise<TeamLaunchResponse>
    >();
    const getRuntimeState = vi.fn<(teamName: string) => TeamRuntimeState>();
    const getProvisioningStatus = vi.fn<(runId: string) => Promise<TeamProvisioningProgress>>();
    const stopTeam = vi.fn<(teamName: string) => void>();
    const getAliveTeams = vi.fn<() => string[]>();
    const teamProvisioningService = {
      launchTeam,
      getRuntimeState,
      getProvisioningStatus,
      stopTeam,
      getAliveTeams,
    } as Pick<
      NonNullable<HttpServices['teamProvisioningService']>,
      'launchTeam' | 'getRuntimeState' | 'getProvisioningStatus' | 'stopTeam' | 'getAliveTeams'
    > as HttpServices['teamProvisioningService'];

    const services = {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamProvisioningService,
    } satisfies HttpServices;

    return {
      services,
      launchTeam,
      getRuntimeState,
      getProvisioningStatus,
      stopTeam,
      getAliveTeams,
    };
  }

  async function createApp() {
    const app = Fastify();
    const mocks = createServicesMock();
    registerTeamRoutes(app, mocks.services);
    await app.ready();
    return { app, ...mocks };
  }

  it('launches a team with validated request payload', async () => {
    const { app, launchTeam } = await createApp();
    launchTeam.mockResolvedValue({ runId: 'run-1' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: '/tmp/project',
          prompt: 'Resume work',
          skipPermissions: false,
          clearContext: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ runId: 'run-1' });
      expect(launchTeam).toHaveBeenCalledWith(
        {
          teamName: 'demo-team',
          cwd: '/tmp/project',
          prompt: 'Resume work',
          skipPermissions: false,
          clearContext: true,
        },
        expect.any(Function)
      );
    } finally {
      await app.close();
    }
  });

  it('rejects launch requests with non-absolute cwd', async () => {
    const { app, launchTeam } = await createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: 'relative/path',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'cwd must be an absolute path' });
      expect(launchTeam).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns runtime state, provisioning status, and stop results', async () => {
    const { app, getRuntimeState, getProvisioningStatus, stopTeam, getAliveTeams } = await createApp();
    getRuntimeState
      .mockReturnValueOnce({
        teamName: 'demo-team',
        isAlive: true,
        runId: 'run-2',
        progress: {
          runId: 'run-2',
          teamName: 'demo-team',
          state: 'ready',
          message: 'Ready',
          startedAt: '2026-03-12T00:00:00.000Z',
          updatedAt: '2026-03-12T00:00:01.000Z',
        },
      })
      .mockReturnValueOnce({
        teamName: 'demo-team',
        isAlive: false,
        runId: null,
        progress: null,
      })
      .mockReturnValueOnce({
        teamName: 'demo-team',
        isAlive: true,
        runId: 'run-2',
        progress: {
          runId: 'run-2',
          teamName: 'demo-team',
          state: 'ready',
          message: 'Ready',
          startedAt: '2026-03-12T00:00:00.000Z',
          updatedAt: '2026-03-12T00:00:01.000Z',
        },
      });
    getProvisioningStatus.mockResolvedValue({
      runId: 'run-2',
      teamName: 'demo-team',
      state: 'ready',
      message: 'Ready',
      startedAt: '2026-03-12T00:00:00.000Z',
      updatedAt: '2026-03-12T00:00:01.000Z',
    });
    getAliveTeams.mockReturnValue(['demo-team']);

    try {
      const runtimeResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/runtime',
      });
      expect(runtimeResponse.statusCode).toBe(200);
      expect(runtimeResponse.json().isAlive).toBe(true);

      const provisioningResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/provisioning/run-2',
      });
      expect(provisioningResponse.statusCode).toBe(200);
      expect(provisioningResponse.json().runId).toBe('run-2');

      const stopResponse = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/stop',
      });
      expect(stopResponse.statusCode).toBe(200);
      expect(stopResponse.json()).toEqual({
        teamName: 'demo-team',
        isAlive: false,
        runId: null,
        progress: null,
      });
      expect(stopTeam).toHaveBeenCalledWith('demo-team');

      const aliveResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/runtime/alive',
      });
      expect(aliveResponse.statusCode).toBe(200);
      expect(aliveResponse.json()).toEqual([
        {
          teamName: 'demo-team',
          isAlive: true,
          runId: 'run-2',
          progress: {
            runId: 'run-2',
            teamName: 'demo-team',
            state: 'ready',
            message: 'Ready',
            startedAt: '2026-03-12T00:00:00.000Z',
            updatedAt: '2026-03-12T00:00:01.000Z',
          },
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it('returns 501 when team runtime routes are registered without a runtime service', async () => {
    const app = Fastify();
    registerTeamRoutes(
      app,
      {
        projectScanner: {} as HttpServices['projectScanner'],
        sessionParser: {} as HttpServices['sessionParser'],
        subagentResolver: {} as HttpServices['subagentResolver'],
        chunkBuilder: {} as HttpServices['chunkBuilder'],
        dataCache: {} as HttpServices['dataCache'],
        updaterService: {} as HttpServices['updaterService'],
        sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      } satisfies HttpServices
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/runtime/alive',
      });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({ error: 'Team runtime control is not available in this mode' });
    } finally {
      await app.close();
    }
  });
});

describe('HTTP team data route parity', () => {
  it('enriches team data with isAlive to match the Electron IPC contract', async () => {
    const app = Fastify();
    const getTeamData = vi.fn(async () => ({
      teamName: 'demo-team',
      config: { name: 'Demo Team' },
      tasks: [],
      members: [],
      messages: [],
      kanbanState: { teamName: 'demo-team', reviewers: [], tasks: {} },
      processes: [],
    }));
    const isTeamAlive = vi.fn(() => true);
    const getLiveLeadProcessMessages = vi.fn(() => []);

    registerTeamRoutes(app, {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamDataService: {
        listTeams: vi.fn(async () => []),
        getTeamData,
      } as unknown as NonNullable<HttpServices['teamDataService']>,
      teamProvisioningService: {
        isTeamAlive,
        getLiveLeadProcessMessages,
      } as unknown as NonNullable<HttpServices['teamProvisioningService']>,
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          teamName: 'demo-team',
          isAlive: true,
        })
      );
      expect(getTeamData).toHaveBeenCalledWith('demo-team');
      expect(isTeamAlive).toHaveBeenCalledWith('demo-team');
      expect(getLiveLeadProcessMessages).toHaveBeenCalledWith('demo-team');
    } finally {
      await app.close();
    }
  });

  it('enriches team summaries with isAlive to keep browser consumers in parity too', async () => {
    const app = Fastify();
    const getTeamData = vi.fn(async () => ({
      teamName: 'demo-team',
      config: { name: 'Demo Team' },
      tasks: [],
      members: [],
      messages: [],
      kanbanState: { teamName: 'demo-team', reviewers: [], tasks: {} },
      processes: [],
    }));
    const isTeamAlive = vi.fn(() => true);
    const getLiveLeadProcessMessages = vi.fn(() => []);

    registerTeamRoutes(app, {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamDataService: {
        listTeams: vi.fn(async () => []),
        getTeamData,
      } as unknown as NonNullable<HttpServices['teamDataService']>,
      teamProvisioningService: {
        isTeamAlive,
        getLiveLeadProcessMessages,
      } as unknown as NonNullable<HttpServices['teamProvisioningService']>,
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/summary',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          teamName: 'demo-team',
          isAlive: true,
        })
      );
      expect(getTeamData).toHaveBeenCalledWith('demo-team');
      expect(isTeamAlive).toHaveBeenCalledWith('demo-team');
      expect(getLiveLeadProcessMessages).toHaveBeenCalledWith('demo-team');
    } finally {
      await app.close();
    }
  });

  it('maps missing newly created teams to TEAM_PROVISIONING while a provisioning run exists', async () => {
    const app = Fastify();
    const getTeamData = vi.fn(async () => {
      throw new Error('Team not found: demo-team');
    });
    const hasProvisioningRun = vi.fn(() => true);

    registerTeamRoutes(app, {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamDataService: {
        listTeams: vi.fn(async () => []),
        getTeamData,
      } as unknown as NonNullable<HttpServices['teamDataService']>,
      teamProvisioningService: {
        hasProvisioningRun,
      } as unknown as NonNullable<HttpServices['teamProvisioningService']>,
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team',
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'TEAM_PROVISIONING' });
      expect(getTeamData).toHaveBeenCalledWith('demo-team');
      expect(hasProvisioningRun).toHaveBeenCalledWith('demo-team');
    } finally {
      await app.close();
    }
  });

  it('maps missing draft teams to TEAM_DRAFT when team metadata exists without config', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-http-teams-'));
    const teamDir = path.join(claudeRoot, 'teams', 'draft-team');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: '/tmp/project',
        createdAt: Date.now(),
      })
    );
    setClaudeBasePathOverride(claudeRoot);

    const app = Fastify();
    const getTeamData = vi.fn(async () => {
      throw new Error('Team not found: draft-team');
    });

    registerTeamRoutes(app, {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamDataService: {
        listTeams: vi.fn(async () => []),
        getTeamData,
      } as unknown as NonNullable<HttpServices['teamDataService']>,
      teamProvisioningService: {
        hasProvisioningRun: vi.fn(() => false),
      } as unknown as NonNullable<HttpServices['teamProvisioningService']>,
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/draft-team',
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'TEAM_DRAFT' });
      expect(getTeamData).toHaveBeenCalledWith('draft-team');
    } finally {
      setClaudeBasePathOverride(null);
      await fs.rm(claudeRoot, { recursive: true, force: true });
      await app.close();
    }
  });
});
