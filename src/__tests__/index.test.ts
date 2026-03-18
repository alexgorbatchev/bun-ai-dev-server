import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';

import { createDevReloadRoutes } from '../index.ts';

type SseConnection = {
  close: () => void;
  readEvent: () => Promise<string>;
};

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
      const chunkResult = await reader.read();
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

describe('createDevReloadRoutes', () => {
  it('delivers change events and clears dirty state after restart', async () => {
    const restartCalls: number[] = [];

    const routes = createDevReloadRoutes({
      isDevelopment: true,
      restartExitCode: 123,
      changeEndpointPath: 'dev/changes',
      restartEndpointPath: 'dev/restart',
      onRestart: (exitCode) => {
        restartCalls.push(exitCode);
      },
    });

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      routes,
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const firstConnection = await connectToSse(`${baseUrl}/dev/changes`);

      try {
        expect(await firstConnection.readEvent()).toBe('connected');
        expect(await firstConnection.readEvent()).toBe('{"dirty":false}');

        const changeResponse = await fetch(`${baseUrl}/dev/changes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: 'src/index.ts' }),
        });

        expect(changeResponse.status).toBe(200);
        expect(await changeResponse.json()).toEqual({ ok: true });
        expect(await firstConnection.readEvent()).toBe('{"dirty":true,"file":"src/index.ts"}');

        const restartResponse = await fetch(`${baseUrl}/dev/restart`, {
          method: 'POST',
        });

        expect(restartResponse.status).toBe(200);
        expect(await restartResponse.json()).toEqual({ ok: true });
        expect(restartCalls).toEqual([123]);
      } finally {
        firstConnection.close();
      }

      const secondConnection = await connectToSse(`${baseUrl}/dev/changes`);
      try {
        expect(await secondConnection.readEvent()).toBe('connected');
        expect(await secondConnection.readEvent()).toBe('{"dirty":false}');
      } finally {
        secondConnection.close();
      }
    } finally {
      server.stop(true);
    }
  });

  it('returns Not available responses when development mode is disabled', async () => {
    const routes = createDevReloadRoutes({
      isDevelopment: false,
    });

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      routes,
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;

      const restartResponse = await fetch(`${baseUrl}/api/dev/restart`, {
        method: 'POST',
      });
      expect(restartResponse.status).toBe(403);
      expect(await restartResponse.json()).toEqual({ error: 'Not available' });

      const changePostResponse = await fetch(`${baseUrl}/api/dev/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'src/index.ts' }),
      });
      expect(changePostResponse.status).toBe(403);
      expect(await changePostResponse.json()).toEqual({ error: 'Not available' });

      const changeGetResponse = await fetch(`${baseUrl}/api/dev/changes`);
      expect(changeGetResponse.status).toBe(403);
      expect(await changeGetResponse.json()).toEqual({ error: 'Not available' });
    } finally {
      server.stop(true);
    }
  });
});
