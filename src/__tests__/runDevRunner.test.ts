import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { FIXTURE_HEALTH_ENDPOINT_PATH, FIXTURE_WATCH_FILE_NAME } from "./fixtures/fixtures--dev-server-contract.ts";
import {
  connectToSse,
  getAvailablePort,
  waitForHealth,
  waitForProcessExit,
  waitForRestartedHealth,
} from "./runDevRunnerTestSupport.ts";

describe("runDevRunner e2e", () => {
  it("starts the dev runner, reports watched changes, and restarts the child server", async () => {
    const watchRootPath = mkdtempSync(join(tmpdir(), "bun-ai-dev-server-e2e-"));
    const watchFilePath = join(watchRootPath, FIXTURE_WATCH_FILE_NAME);

    writeFileSync(watchFilePath, "export const WATCH_VALUE = 1;\n", "utf8");

    const port = getAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const healthUrl = `${baseUrl}${FIXTURE_HEALTH_ENDPOINT_PATH}`;

    const runnerProcess = Bun.spawn({
      cmd: ["bun", "src/cli.ts", "--", "bun", "src/__tests__/fixtures/fixtures--dev-server.ts"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        DEV_SERVER_URL: baseUrl,
        DEV_WATCH_ROOT: watchRootPath,
        DEV_WATCH_PATTERN: "**/*.ts",
        DEV_WATCH_DEBOUNCE_MS: "40",
        DEV_WATCH_GITIGNORE: "0",
        DEV_LABEL: "e2e-test",
      },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });

    try {
      const firstHealth = await waitForHealth(healthUrl, 10_000);

      const firstConnection = await connectToSse(`${baseUrl}/api/dev/changes`);
      try {
        expect(await firstConnection.readEvent()).toBe("connected");
        expect(await firstConnection.readEvent()).toBe('{"dirty":false}');

        writeFileSync(watchFilePath, "export const WATCH_VALUE = 2;\n", "utf8");

        expect(await firstConnection.readEvent()).toBe('{"dirty":true,"file":"watched.ts"}');
      } finally {
        firstConnection.close();
      }

      const restartResponse = await fetch(`${baseUrl}/api/dev/restart`, {
        method: "POST",
      });
      expect(restartResponse.status).toBe(200);
      expect(await restartResponse.json()).toEqual({ ok: true });

      const restartedHealth = await waitForRestartedHealth(healthUrl, firstHealth.processId, 10_000);
      expect(restartedHealth.processId).not.toBe(firstHealth.processId);

      const secondConnection = await connectToSse(`${baseUrl}/api/dev/changes`);
      try {
        expect(await secondConnection.readEvent()).toBe("connected");
        expect(await secondConnection.readEvent()).toBe('{"dirty":false}');
      } finally {
        secondConnection.close();
      }
    } finally {
      runnerProcess.kill("SIGTERM");
      const exitCode = await waitForProcessExit(runnerProcess, 5_000);
      expect(exitCode).toBe(0);
      rmSync(watchRootPath, { recursive: true, force: true });
    }
  });
});
