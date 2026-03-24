import type { TeamProvisioningState } from '@shared/types/team';

/** Display steps for the provisioning stepper (0-indexed). */
export const DISPLAY_STEPS = [
  { key: 'starting', label: 'Starting' },
  { key: 'configuring', label: 'Team setup' },
  { key: 'assembling', label: 'Members joining' },
  { key: 'finalizing', label: 'Finalizing' },
] as const;

/**
 * Maps a backend provisioning state to a 0-based display step index.
 * Returns DISPLAY_STEPS.length for 'ready' (all steps complete), -1 for terminal/unknown.
 */
export function getDisplayStepIndex(state: Exclude<TeamProvisioningState, 'idle'>): number {
  switch (state) {
    case 'validating':
    case 'spawning':
      return 0;
    case 'configuring':
      return 1;
    case 'assembling':
      return 2;
    case 'finalizing':
    case 'verifying':
      return 3;
    case 'ready':
      return DISPLAY_STEPS.length;
    default:
      return -1;
  }
}
