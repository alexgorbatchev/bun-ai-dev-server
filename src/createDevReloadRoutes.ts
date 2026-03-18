import {
  DEFAULT_CHANGE_ENDPOINT_PATH,
  DEFAULT_RESTART_ENDPOINT_PATH,
  DEFAULT_RESTART_EXIT_CODE,
} from './constants';

const DEFAULT_RESTART_DELAY_MS = 100;

type DevReloadClientController = ReadableStreamDefaultController<Uint8Array>;

type DevReloadRouteHandler = {
  GET?: (request: Request) => Response;
  POST?: (request: Request) => Response | Promise<Response>;
};

export type DevReloadRoutes = Record<string, DevReloadRouteHandler>;

export type DevReloadChangeEvent = {
  dirty: boolean;
  file?: string;
};

export type CreateDevReloadRoutesOptions = {
  restartExitCode?: number;
  isDevelopment?: boolean;
  changeEndpointPath?: string;
  restartEndpointPath?: string;
  restartDelayMs?: number;
  onRestart?: (restartExitCode: number) => void;
};

function normalizeEndpointPath(value: string | undefined, fallbackValue: string): string {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return fallbackValue;
  }

  if (normalizedValue.startsWith('/')) {
    return normalizedValue;
  }

  return `/${normalizedValue}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getChangedFile(payload: unknown): string | null {
  if (!isObjectRecord(payload)) {
    return null;
  }

  const file = payload.file;
  if (typeof file !== 'string') {
    return null;
  }

  const normalizedFile = file.trim();
  if (normalizedFile.length === 0) {
    return null;
  }

  return normalizedFile;
}

function createNotAvailableResponse(): Response {
  return Response.json({ error: 'Not available' }, { status: 403 });
}

function broadcastDevChange(
  devClients: Set<DevReloadClientController>,
  encoder: TextEncoder,
  payload: DevReloadChangeEvent,
): void {
  const encodedPayload = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

  for (const client of devClients) {
    try {
      client.enqueue(encodedPayload);
    } catch {
      devClients.delete(client);
    }
  }
}

export function createDevReloadRoutes(options: CreateDevReloadRoutesOptions = {}): DevReloadRoutes {
  const {
    onRestart,
    restartExitCode = DEFAULT_RESTART_EXIT_CODE,
    isDevelopment = process.env.NODE_ENV === 'development',
    restartDelayMs = DEFAULT_RESTART_DELAY_MS,
    changeEndpointPath: changeEndpointPathOption,
    restartEndpointPath: restartEndpointPathOption,
  } = options;

  const changeEndpointPath = normalizeEndpointPath(changeEndpointPathOption, DEFAULT_CHANGE_ENDPOINT_PATH);
  const restartEndpointPath = normalizeEndpointPath(restartEndpointPathOption, DEFAULT_RESTART_ENDPOINT_PATH);
  const encoder = new TextEncoder();
  const devClients = new Set<DevReloadClientController>();
  let hasChanges = false;

  const runRestart = onRestart ?? ((exitCode: number): void => {
    setTimeout(() => process.exit(exitCode), restartDelayMs);
  });

  return {
    [restartEndpointPath]: {
      POST(): Response {
        if (!isDevelopment) {
          return createNotAvailableResponse();
        }

        hasChanges = false;
        runRestart(restartExitCode);
        return Response.json({ ok: true });
      },
    },
    [changeEndpointPath]: {
      GET(request: Request): Response {
        if (!isDevelopment) {
          return createNotAvailableResponse();
        }

        let streamController: DevReloadClientController | null = null;

        request.signal.addEventListener('abort', () => {
          if (!streamController) {
            return;
          }

          devClients.delete(streamController);
        });

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              streamController = controller;
              devClients.add(controller);
              controller.enqueue(encoder.encode('data: connected\n\n'));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ dirty: hasChanges })}\n\n`));
            },
            cancel(): void {
              if (!streamController) {
                return;
              }

              devClients.delete(streamController);
              streamController = null;
            },
          }),
          {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            },
          },
        );
      },
      async POST(request: Request): Promise<Response> {
        if (!isDevelopment) {
          return createNotAvailableResponse();
        }

        let changedFile: string | null = null;
        try {
          changedFile = getChangedFile(await request.json());
        } catch {
          // Ignore malformed payloads and still broadcast a generic dirty signal.
        }

        hasChanges = true;
        const payload: DevReloadChangeEvent = changedFile ? { dirty: true, file: changedFile } : { dirty: true };
        broadcastDevChange(devClients, encoder, payload);

        return Response.json({ ok: true });
      },
    },
  };
}
