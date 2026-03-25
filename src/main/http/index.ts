/**
 * HTTP Route Registration Orchestrator.
 *
 * Registers all domain-specific route handlers on a Fastify instance.
 * Each route file mirrors the corresponding IPC handler.
 */

import { createLogger } from '@shared/utils/logger';

import { registerConfigRoutes } from './config';
import { registerCrossTeamRoutes } from './crossTeam';
import { registerEventRoutes } from './events';
import { registerEditorRoutes } from './editor';
import { registerNotificationRoutes } from './notifications';
import { registerProjectRoutes } from './projects';
import { registerSearchRoutes } from './search';
import { registerSessionRoutes } from './sessions';
import { registerReviewRoutes } from './review';
import { registerSshRoutes } from './ssh';
import { registerSubagentRoutes } from './subagents';
import { registerTeamRoutes } from './teams';
import { registerUpdaterRoutes } from './updater';
import { registerUtilityRoutes } from './utility';
import { registerValidationRoutes } from './validation';

import type {
  ChunkBuilder,
  DataCache,
  ProjectScanner,
  SessionParser,
  SubagentResolver,
  ChangeExtractorService,
  CrossTeamService,
  FileContentResolver,
  GitDiffFallback,
  MemberStatsComputer,
  ReviewApplierService,
  TeamBackupService,
  TeamDataService,
  TeamMemberLogsFinder,
  UpdaterService,
} from '../services';
import type { FileSearchService, GitStatusService, ProjectFileService } from '../services/editor';
import type { SshConnectionManager } from '../services/infrastructure/SshConnectionManager';
import type { TeamProvisioningService } from '../services/team/TeamProvisioningService';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:routes');

export interface HttpServices {
  projectScanner: ProjectScanner;
  sessionParser: SessionParser;
  subagentResolver: SubagentResolver;
  chunkBuilder: ChunkBuilder;
  dataCache: DataCache;
  updaterService: UpdaterService;
  sshConnectionManager: SshConnectionManager;
  teamDataService?: TeamDataService;
  teamProvisioningService?: TeamProvisioningService;
  teamMemberLogsFinder?: TeamMemberLogsFinder;
  memberStatsComputer?: MemberStatsComputer;
  teamBackupService?: TeamBackupService;
  crossTeamService?: CrossTeamService;
  changeExtractor?: ChangeExtractorService;
  fileContentResolver?: FileContentResolver;
  gitDiffFallback?: GitDiffFallback;
  reviewApplier?: ReviewApplierService;
  projectFileService?: ProjectFileService;
  fileSearchService?: FileSearchService;
  gitStatusService?: GitStatusService;
  eventBroadcaster?: (channel: string, data: unknown) => void;
}

export function registerHttpRoutes(
  app: FastifyInstance,
  services: HttpServices,
  sshModeSwitchCallback: (mode: 'local' | 'ssh') => Promise<void>
): void {
  registerProjectRoutes(app, services);
  registerSessionRoutes(app, services);
  registerSearchRoutes(app, services);
  registerSubagentRoutes(app, services);
  registerTeamRoutes(app, services);
  registerCrossTeamRoutes(app, services);
  registerReviewRoutes(app, services);
  registerEditorRoutes(app, services);
  registerNotificationRoutes(app);
  registerConfigRoutes(app);
  registerValidationRoutes(app);
  registerUtilityRoutes(app);
  registerSshRoutes(app, services.sshConnectionManager, sshModeSwitchCallback);
  registerUpdaterRoutes(app, services);
  registerEventRoutes(app);

  logger.info('All HTTP routes registered');
}
