import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  FIXTURE_HEALTH_ENDPOINT_PATH,
  FIXTURE_WATCH_FILE_NAME,
  type FixtureHealthResponse,
} from './fixtures/fixtures--dev-server-contract.ts';

type SseConnection = {
  close: () => void;
  readEvent: () => Promise<string>;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFixtureHealthResponse(value: unknown): value is FixtureHealthResponse {
  if (!isObjectRecord(value)) {
    return false;
  }

  const processId = value.processId;
  const startedAt = value.startedAt;

  return typeof processId === 'number'
    && Number.isFinite(processId)
    && typeof startedAt === 'number'
    && Number.isFinite(startedAt);
}

function getAvailablePort(): number {
  const probeServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(): Response {
      return new Response('ok');
    },
  });

  const port = probeServer.port;
  assert(port !== undefined);
  probeServer.stop(true);
  return port;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<FixtureHealthResponse> {
  const startedAt = Date.now();
  let lastFailure = 'health endpoint not ready';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const payload = await response.json();
        if (isFixtureHealthResponse(payload)) {
          return payload;
        }

        lastFailure = `unexpected payload: ${JSON.stringify(payload)}`;
      } else {
        lastFailure = `status ${response.status}`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for fixture server health (${lastFailure})`);
}

async function waitForRestartedHealth(
  url: string,
  previousProcessId: number,
  timeoutMs: number,
): Promise<FixtureHealthResponse> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const health = await waitForHealth(url, 500);
    if (health.processId !== previousProcessId) {
      return health;
    }

    await Bun.sleep(75);
  }

  throw new Error('Timed out waiting for restarted fixture process');
}

async function connectToSse(url: string): Promise<SseConnection> {
  const abortController = new AbortController();
  const response = await fetch(url, { signal: abortController.signal });
  expect(response.status).toBe(200);
  assert(response.body);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const queuedEvents: string[] = [];

  const readEvent = async (): Promise<string> => {
    while (queuedEvents.length === 0) {
      const timeoutPromise = Bun.sleep(5_000).then(() => {
        throw new Error('Timed out waiting for SSE event');
      });
      const readPromise = reader.read();
      const chunkResult = await Promise.race([readPromise, timeoutPromise]);
      assert(!chunkResult.done);
      buffer += chunkResult.value;

      const frames = buffer.split('\n\n');
      const tail = frames.pop();
      assert(tail !== undefined);
      buffer = tail;

      const frameEvents = frames.flatMap((frame) => {
        return frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length));
      });
      queuedEvents.push(...frameEvents);
    }

    const nextEvent = queuedEvents.shift();
    assert(nextEvent !== undefined);
    return nextEvent;
  };

  const close = (): void => {
    abortController.abort();
    void reader.cancel();
  };

  return {
    close,
    readEvent,
  };
}

async function waitForProcessExit(process: Bun.Subprocess, timeoutMs: number): Promise<number> {
  const timeoutPromise = Bun.sleep(timeoutMs).then(() => {
    throw new Error(`Timed out waiting for runner shutdown (${timeoutMs}ms)`);
  });

  return Promise.race([process.exited, timeoutPromise]);
}

describe('runDevRunner e2e', () => {
  it('starts the dev runner, reports watched changes, and restarts the child server', async () => {
    const watchRootPath = mkdtempSync(join(tmpdir(), 'bun-ai-dev-server-e2e-'));
    const watchFilePath = join(watchRootPath, FIXTURE_WATCH_FILE_NAME);

    writeFileSync(watchFilePath, 'export const WATCH_VALUE = 1;\n', 'utf8');

    const port = getAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const healthUrl = `${baseUrl}${FIXTURE_HEALTH_ENDPOINT_PATH}`;

    const runnerProcess = Bun.spawn({
      cmd: ['bun', 'src/cli.ts', '--', 'bun', 'src/__tests__/fixtures/fixtures--dev-server.ts'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        DEV_SERVER_URL: baseUrl,
        DEV_WATCH_ROOT: watchRootPath,
        DEV_WATCH_PATTERN: '**/*.ts',
        DEV_WATCH_DEBOUNCE_MS: '40',
        DEV_WATCH_GITIGNORE: '0',
        DEV_LABEL: 'e2e-test',
      },
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    });

    try {
      const firstHealth = await waitForHealth(healthUrl, 10_000);

      const firstConnection = await connectToSse(`${baseUrl}/api/dev/changes`);
      try {
        expect(await firstConnection.readEvent()).toBe('connected');
        expect(await firstConnection.readEvent()).toBe('{"dirty":false}');

        writeFileSync(watchFilePath, 'export const WATCH_VALUE = 2;\n', 'utf8');

        expect(await firstConnection.readEvent()).toBe('{"dirty":true,"file":"watched.ts"}');
      } finally {
        firstConnection.close();
      }

      const restartResponse = await fetch(`${baseUrl}/api/dev/restart`, {
        method: 'POST',
      });
      expect(restartResponse.status).toBe(200);
      expect(await restartResponse.json()).toEqual({ ok: true });

      const restartedHealth = await waitForRestartedHealth(healthUrl, firstHealth.processId, 10_000);
      expect(restartedHealth.processId).not.toBe(firstHealth.processId);

      const secondConnection = await connectToSse(`${baseUrl}/api/dev/changes`);
      try {
        expect(await secondConnection.readEvent()).toBe('connected');
        expect(await secondConnection.readEvent()).toBe('{"dirty":false}');
      } finally {
        secondConnection.close();
      }
    } finally {
      runnerProcess.kill('SIGTERM');
      const exitCode = await waitForProcessExit(runnerProcess, 5_000);
      expect(exitCode).toBe(0);
      rmSync(watchRootPath, { recursive: true, force: true });
    }
  });
});
