import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/services/parsing/GitIdentityResolver', () => ({
  gitIdentityResolver: {
    getBranch: vi.fn(),
  },
}));

import { gitIdentityResolver } from '@main/services/parsing/GitIdentityResolver';
import { registerTeamRoutes } from '@main/http/teams';
import type { HttpServices } from '@main/http';

describe('HTTP team project branch routes', () => {
  it('resolves browser project paths through the compatibility route', async () => {
    const app = Fastify();
    const getBranch = gitIdentityResolver.getBranch as unknown as ReturnType<typeof vi.fn>;
    getBranch.mockResolvedValue('feature/swarm');

    registerTeamRoutes(app, {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamDataService: {} as HttpServices['teamDataService'],
      teamProvisioningService: {
        launchTeam: vi.fn(),
        getRuntimeState: vi.fn(),
        getProvisioningStatus: vi.fn(),
        stopTeam: vi.fn(),
        getAliveTeams: vi.fn(),
      } as unknown as NonNullable<HttpServices['teamProvisioningService']>,
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/project-branch?projectPath=%2Fworkspace%2Fmatrix',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toBe('feature/swarm');
      expect(getBranch).toHaveBeenCalledWith('/workspace/matrix');
    } finally {
      await app.close();
    }
  });
});
