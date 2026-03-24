/**
 * Vitest setup file.
 * Runs before each test file.
 */

import { afterEach, beforeEach, expect, vi } from 'vitest';

// Mock Sentry Electron SDK — it requires the real `electron` package at import
// time which is unavailable in the vitest/happy-dom environment.
const sentryNoOp = {
  init: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  startSpan: vi.fn((_opts: unknown, fn: () => unknown) => fn()),
  withScope: vi.fn((fn: (scope: unknown) => void) => fn({ setContext: vi.fn() })),
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing', setup: vi.fn(), afterAllSetup: vi.fn() })),
};
vi.mock('@sentry/electron/main', () => sentryNoOp);
vi.mock('@sentry/electron/renderer', () => sentryNoOp);
vi.mock('@sentry/react', () => sentryNoOp);

// Mock HOME for tests that need a predictable home path. Use stubEnv so we never
// touch process itself — stubbing process breaks vitest (process.listeners etc).
vi.stubEnv('HOME', '/home/testuser');

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function formatConsoleCall(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return arg.message;
      }
      return String(arg);
    })
    .join(' ');
}

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  const unexpectedErrors = errorSpy.mock.calls.map(formatConsoleCall);
  const unexpectedWarnings = warnSpy.mock.calls.map(formatConsoleCall);

  errorSpy.mockRestore();
  warnSpy.mockRestore();

  expect(
    unexpectedErrors,
    `Unexpected console.error calls:\n${unexpectedErrors.join('\n')}`
  ).toEqual([]);
  expect(
    unexpectedWarnings,
    `Unexpected console.warn calls:\n${unexpectedWarnings.join('\n')}`
  ).toEqual([]);
});
