import assert from "node:assert";

import { expect } from "bun:test";

import type { FixtureHealthResponse } from "./FixtureHealthResponse.ts";

type SseConnection = {
  close: () => void;
  readEvent: () => Promise<string>;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFixtureHealthResponse(value: unknown): value is FixtureHealthResponse {
  if (!isObjectRecord(value)) {
    return false;
  }

  const processId = value.processId;
  const startedAt = value.startedAt;

  return (
    typeof processId === "number" &&
    Number.isFinite(processId) &&
    typeof startedAt === "number" &&
    Number.isFinite(startedAt)
  );
}

export function getAvailablePort(): number {
  const probeServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(): Response {
      return new Response("ok");
    },
  });

  const port = probeServer.port;
  assert(port !== undefined);
  probeServer.stop(true);
  return port;
}

export async function waitForHealth(url: string, timeoutMs: number): Promise<FixtureHealthResponse> {
  const startedAt = Date.now();
  let lastFailure = "health endpoint not ready";

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
      lastFailure = readErrorMessage(error);
    }

    await Bun.sleep(50);
  }

  assert.fail(`Timed out waiting for fixture server health (${lastFailure})`);
}

export async function waitForRestartedHealth(
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

  assert.fail("Timed out waiting for restarted fixture process");
}

export async function connectToSse(url: string): Promise<SseConnection> {
  const abortController = new AbortController();
  const response = await fetch(url, { signal: abortController.signal });
  expect(response.status).toBe(200);
  assert(response.body);

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const queuedEvents: string[] = [];

  const readEvent = async (): Promise<string> => {
    while (queuedEvents.length === 0) {
      const timeoutPromise = Bun.sleep(5_000).then(() => {
        assert.fail("Timed out waiting for SSE event");
      });
      const chunkResult = await Promise.race([reader.read(), timeoutPromise]);
      assert(!chunkResult.done);
      buffer += chunkResult.value;

      const frames = buffer.split("\n\n");
      const tail = frames.pop();
      assert(tail !== undefined);
      buffer = tail;

      const frameEvents = frames.flatMap((frame) => {
        return frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length));
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

export async function waitForProcessExit(process: Bun.Subprocess, timeoutMs: number): Promise<number> {
  const timeoutPromise = Bun.sleep(timeoutMs).then(() => {
    assert.fail(`Timed out waiting for runner shutdown (${timeoutMs}ms)`);
  });

  return Promise.race([process.exited, timeoutPromise]);
}
