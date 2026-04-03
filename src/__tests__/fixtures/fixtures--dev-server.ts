import { createDevReloadRoutes } from "../../index.ts";

import type { FixtureHealthResponse } from "../FixtureHealthResponse.ts";
import { FIXTURE_HEALTH_ENDPOINT_PATH } from "./fixtures--dev-server-contract.ts";

function parsePort(value: string | undefined, fallbackPort: number): number {
  if (!value) {
    return fallbackPort;
  }

  const parsedPort = Number.parseInt(value, 10);
  if (!Number.isFinite(parsedPort)) {
    return fallbackPort;
  }

  return parsedPort;
}

function createHealthPayload(startedAt: number): FixtureHealthResponse {
  return {
    processId: process.pid,
    startedAt,
  };
}

function startFixtureDevServer(): void {
  const startedAt = Date.now();
  const port = parsePort(process.env.PORT, 3100);

  const routes = createDevReloadRoutes({
    isDevelopment: true,
    restartDelayMs: 20,
  });

  Bun.serve({
    hostname: "127.0.0.1",
    port,
    routes: {
      ...routes,
      [FIXTURE_HEALTH_ENDPOINT_PATH]: {
        GET(): Response {
          return Response.json(createHealthPayload(startedAt));
        },
      },
    },
  });
}

startFixtureDevServer();
