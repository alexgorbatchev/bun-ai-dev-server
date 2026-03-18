import { DEFAULT_CHANGE_ENDPOINT_PATH, DEFAULT_RESTART_ENDPOINT_PATH } from './constants';

const DEFAULT_RELOAD_DELAY_MS = 1500;

type DevReloadHotkey = {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

const DEFAULT_RESTART_HOTKEY: DevReloadHotkey = {
  key: 'X',
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
};

export type DevReloadClientChangeEvent = {
  dirty: boolean;
  file?: string;
};

export type DevReloadClient = {
  enabled: boolean;
  subscribe: (listener: (event: DevReloadClientChangeEvent) => void) => () => void;
  restart: () => Promise<void>;
  installHotkey: () => () => void;
};

export type CreateDevReloadClientOptions = {
  enabled?: boolean;
  changeEndpointPath?: string;
  restartEndpointPath?: string;
  reloadDelayMs?: number;
  hotkey?: Partial<DevReloadHotkey>;
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

function getActiveWindow(): Window | null {
  return typeof window === 'undefined' ? null : window;
}

function resolveEnabled(activeWindow: Window | null, enabled: boolean | undefined): boolean {
  if (typeof enabled === 'boolean') {
    return enabled;
  }

  if (!activeWindow) {
    return false;
  }

  const port = activeWindow.location.port;
  return port !== '' && port !== '80' && port !== '443';
}

function parseDevChangeEvent(rawData: string): DevReloadClientChangeEvent | null {
  if (rawData === 'connected') {
    return null;
  }

  try {
    const payload = JSON.parse(rawData);
    if (typeof payload !== 'object' || payload === null) {
      return { dirty: true };
    }

    const dirtyValue = payload.dirty;
    const fileValue = payload.file;
    const dirty = typeof dirtyValue === 'boolean' ? dirtyValue : true;
    const file = typeof fileValue === 'string' && fileValue.trim().length > 0 ? fileValue : undefined;

    return file ? { dirty, file } : { dirty };
  } catch {
    return { dirty: true };
  }
}

function isHotkeyMatch(event: KeyboardEvent, hotkey: DevReloadHotkey): boolean {
  return event.key.toLowerCase() === hotkey.key.toLowerCase()
    && event.ctrlKey === hotkey.ctrlKey
    && event.shiftKey === hotkey.shiftKey
    && event.altKey === hotkey.altKey
    && event.metaKey === hotkey.metaKey;
}

export function createDevReloadClient(options: CreateDevReloadClientOptions = {}): DevReloadClient {
  const activeWindow = getActiveWindow();
  const enabled = resolveEnabled(activeWindow, options.enabled);
  const changeEndpointPath = normalizeEndpointPath(options.changeEndpointPath, DEFAULT_CHANGE_ENDPOINT_PATH);
  const restartEndpointPath = normalizeEndpointPath(options.restartEndpointPath, DEFAULT_RESTART_ENDPOINT_PATH);
  const reloadDelayMs = options.reloadDelayMs ?? DEFAULT_RELOAD_DELAY_MS;
  const hotkey: DevReloadHotkey = { ...DEFAULT_RESTART_HOTKEY, ...options.hotkey };

  const subscribe = (listener: (event: DevReloadClientChangeEvent) => void): () => void => {
    if (!enabled || !activeWindow) {
      return () => {
        return;
      };
    }

    const eventSource = new EventSource(changeEndpointPath);

    const handlePayload = (rawData: string): void => {
      const event = parseDevChangeEvent(rawData);
      if (!event) {
        return;
      }

      listener(event);
    };

    const handleMessage = (event: MessageEvent<string>): void => {
      handlePayload(event.data);
    };

    const handleChangeEvent = (event: Event): void => {
      if (!(event instanceof MessageEvent)) {
        return;
      }

      handlePayload(typeof event.data === 'string' ? event.data : String(event.data));
    };

    eventSource.onmessage = handleMessage;
    eventSource.addEventListener('change', handleChangeEvent);
    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.removeEventListener('change', handleChangeEvent);
      eventSource.close();
    };
  };

  const restart = async (): Promise<void> => {
    if (!enabled || !activeWindow) {
      return;
    }

    const response = await fetch(restartEndpointPath, { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Failed to restart dev server (${response.status})`);
    }

    setTimeout(() => {
      activeWindow.location.reload();
    }, reloadDelayMs);
  };

  const installHotkey = (): () => void => {
    if (!enabled || !activeWindow) {
      return () => {
        return;
      };
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isHotkeyMatch(event, hotkey)) {
        return;
      }

      event.preventDefault();
      void restart().catch(() => {
        return;
      });
    };

    activeWindow.addEventListener('keydown', handleKeyDown);

    return () => {
      activeWindow.removeEventListener('keydown', handleKeyDown);
    };
  };

  return {
    enabled,
    subscribe,
    restart,
    installHotkey,
  };
}
