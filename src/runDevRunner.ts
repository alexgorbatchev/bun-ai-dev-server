import { spawn, type Subprocess } from "bun";
import { existsSync, type FSWatcher, watch } from "fs";
import { isAbsolute, relative, resolve } from "path";

import { DEFAULT_CHANGE_ENDPOINT_PATH, DEFAULT_RESTART_EXIT_CODE } from "./constants";

const DEFAULT_COMMAND = ["bun", "run", "server/index.ts"];
const DEFAULT_LABEL = "dev";
const DEFAULT_NODE_ENV = "development";
const DEFAULT_WATCH_DEBOUNCE_MS = 300;
const DEFAULT_WATCH_PATTERN = "**/*.{ts,tsx,css,html,md}";

type DevRunnerState = {
  proc: Subprocess | null;
  isShuttingDown: boolean;
  isStarting: boolean;
};

export type DevRunnerConfig = {
  command: string[];
  restartExitCode: number;
  nodeEnv: string;
  label: string;
  hintMessage: string | null;
  watchEnabled: boolean;
  watchRoot: string;
  watchPattern: string;
  watchDebounceMs: number;
  respectGitIgnore: boolean;
  gitExecutablePath: string | null;
  serverBaseUrl: string;
  changeEndpointPath: string;
};

function parseInteger(value: string | undefined, fallbackValue: number): number {
  if (!value) {
    return fallbackValue;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isFinite(parsedValue)) {
    return fallbackValue;
  }

  return parsedValue;
}

function parseEnabled(value: string | undefined, fallbackValue: boolean): boolean {
  if (!value) {
    return fallbackValue;
  }

  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue !== "0" && normalizedValue !== "false" && normalizedValue !== "off";
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function getCommand(): string[] {
  const rawArgs = process.argv.slice(2);
  const commandFromArgs = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const commandFromEnv = process.env.DEV_COMMAND?.trim().split(/\s+/) ?? [];

  if (commandFromArgs.length > 0) {
    return commandFromArgs;
  }

  if (commandFromEnv.length > 0) {
    return commandFromEnv;
  }

  return DEFAULT_COMMAND;
}

function getWatchRoot(): string {
  const value = process.env.DEV_WATCH_ROOT?.trim();
  if (!value) {
    return process.cwd();
  }

  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function toRelativeWatchPath(watchRoot: string, filename: string): string | null {
  const normalizedFilename = normalizePath(filename);
  if (normalizedFilename.length === 0) {
    return null;
  }

  if (!isAbsolute(filename)) {
    return normalizedFilename.startsWith("./") ? normalizedFilename.slice(2) : normalizedFilename;
  }

  const relativePath = normalizePath(relative(watchRoot, filename));
  if (relativePath === ".." || relativePath.startsWith("../")) {
    return null;
  }

  return relativePath;
}

function getChangeEndpointPath(): string {
  const rawValue = process.env.DEV_CHANGE_ENDPOINT_PATH?.trim();
  if (!rawValue) {
    return DEFAULT_CHANGE_ENDPOINT_PATH;
  }

  if (rawValue.startsWith("/")) {
    return rawValue;
  }

  return `/${rawValue}`;
}

function getConfig(): DevRunnerConfig {
  const port = process.env.PORT ?? "3100";
  const respectGitIgnore = parseEnabled(process.env.DEV_WATCH_GITIGNORE, true);

  return {
    command: getCommand(),
    restartExitCode: parseInteger(process.env.DEV_RESTART_EXIT_CODE, DEFAULT_RESTART_EXIT_CODE),
    nodeEnv: process.env.NODE_ENV ?? DEFAULT_NODE_ENV,
    label: process.env.DEV_LABEL ?? DEFAULT_LABEL,
    hintMessage: process.env.DEV_HINT ?? null,
    watchEnabled: parseEnabled(process.env.DEV_WATCH, true),
    watchRoot: getWatchRoot(),
    watchPattern: process.env.DEV_WATCH_PATTERN?.trim() || DEFAULT_WATCH_PATTERN,
    watchDebounceMs: parseInteger(process.env.DEV_WATCH_DEBOUNCE_MS, DEFAULT_WATCH_DEBOUNCE_MS),
    respectGitIgnore,
    gitExecutablePath: respectGitIgnore ? Bun.which("git") : null,
    serverBaseUrl: process.env.DEV_SERVER_URL ?? `http://localhost:${port}`,
    changeEndpointPath: getChangeEndpointPath(),
  };
}

function log(config: DevRunnerConfig, color: string, message: string): void {
  console.log(`${color}[${config.label}]\x1b[0m ${message}`);
}

function isGitIgnored(config: DevRunnerConfig, relativePath: string): boolean {
  if (!config.respectGitIgnore || !config.gitExecutablePath) {
    return false;
  }

  if (relativePath === ".git" || relativePath.startsWith(".git/")) {
    return true;
  }

  const checkResult = Bun.spawnSync({
    cmd: [config.gitExecutablePath, "check-ignore", "--quiet", "--no-index", "--", relativePath],
    cwd: config.watchRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  return checkResult.exitCode === 0;
}

function logRetryMode(config: DevRunnerConfig): void {
  if (config.watchEnabled) {
    log(config, "\x1b[33m", "Waiting for the next file change before retrying startup");
    return;
  }

  log(config, "\x1b[33m", "Watch is disabled; no automatic retry will happen until you restart dev.ts");
}

async function notifyServerOfChange(config: DevRunnerConfig, file: string): Promise<void> {
  try {
    const response = await fetch(`${config.serverBaseUrl}${config.changeEndpointPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    });

    if (!response.ok) {
      log(config, "\x1b[31m", `Failed to notify change (${response.status}) for ${file}`);
    }
  } catch {
    return;
  }
}

function handleChildExit(config: DevRunnerConfig, state: DevRunnerState, exitCode: number): void {
  if (state.isShuttingDown) {
    return;
  }

  if (exitCode === config.restartExitCode) {
    log(config, "\x1b[33m", `Restart requested (exit code ${exitCode})`);
    start(config, state, "restart request");
    return;
  }

  if (exitCode === 0) {
    log(config, "\x1b[33m", "Child process exited normally");
  } else {
    log(config, "\x1b[31m", `Child process exited with code ${exitCode}`);
  }

  logRetryMode(config);
}

function start(config: DevRunnerConfig, state: DevRunnerState, reason: string): void {
  if (state.isShuttingDown || state.proc || state.isStarting) {
    return;
  }

  state.isStarting = true;

  try {
    const spawnedProc = spawn(config.command, {
      stdio: ["inherit", "inherit", "inherit"],
      env: {
        ...process.env,
        NODE_ENV: config.nodeEnv,
        DEV_RESTART_EXIT_CODE: String(config.restartExitCode),
      },
    });

    state.proc = spawnedProc;
    state.isStarting = false;
    log(config, "\x1b[32m", `Started "${config.command.join(" ")}" (${reason}, pid ${spawnedProc.pid})`);

    void spawnedProc.exited
      .then((exitCode) => {
        state.proc = null;
        handleChildExit(config, state, exitCode);
      })
      .catch((error) => {
        state.proc = null;
        if (state.isShuttingDown) {
          return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        log(config, "\x1b[31m", `Failed while waiting for child process exit: ${errorMessage}`);
        logRetryMode(config);
      });
  } catch (error) {
    state.isStarting = false;
    state.proc = null;

    const errorMessage = error instanceof Error ? error.message : String(error);
    log(config, "\x1b[31m", `Failed to start "${config.command.join(" ")}": ${errorMessage}`);
    logRetryMode(config);
  }
}

function setupWatchers(config: DevRunnerConfig, state: DevRunnerState): FSWatcher[] {
  if (!config.watchEnabled) {
    log(config, "\x1b[36m", "File watching disabled (set DEV_WATCH=1 to enable)");
    return [];
  }

  if (!existsSync(config.watchRoot)) {
    log(config, "\x1b[31m", `Watch root does not exist: ${config.watchRoot}`);
    return [];
  }

  const watchableFileGlob = new Bun.Glob(config.watchPattern);
  let pendingFile: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const watcher = watch(config.watchRoot, { recursive: true }, (_eventType, filename) => {
      if (!filename) {
        return;
      }

      const relativePath = toRelativeWatchPath(config.watchRoot, filename);
      if (!relativePath) {
        return;
      }

      if (!watchableFileGlob.match(relativePath)) {
        return;
      }

      if (isGitIgnored(config, relativePath)) {
        return;
      }

      pendingFile = relativePath;
      if (timer) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        const fileToSend = pendingFile;
        pendingFile = null;
        if (!fileToSend) {
          return;
        }

        log(config, "\x1b[33m", `Change detected: ${fileToSend}`);

        if (!state.proc && !state.isStarting) {
          log(config, "\x1b[36m", `Retrying startup because ${fileToSend} changed`);
          start(config, state, `file change (${fileToSend})`);
          return;
        }

        void notifyServerOfChange(config, fileToSend);
      }, config.watchDebounceMs);
    });

    log(config, "\x1b[36m", `Watching root: ${config.watchRoot}`);
    log(config, "\x1b[36m", `Watch glob: ${config.watchPattern}`);
    log(config, "\x1b[36m", `Respect .gitignore: ${config.respectGitIgnore ? "yes" : "no"}`);

    return [watcher];
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(config, "\x1b[31m", `Failed to watch ${config.watchRoot}: ${errorMessage}`);
    return [];
  }
}

function shutdown(config: DevRunnerConfig, state: DevRunnerState, watchers: FSWatcher[], signal: NodeJS.Signals): void {
  if (state.isShuttingDown) {
    return;
  }

  state.isShuttingDown = true;
  log(config, "\x1b[36m", `Shutting down (${signal})`);

  for (const watcher of watchers) {
    watcher.close();
  }

  if (state.proc) {
    state.proc.kill(signal);
  }

  process.exit(0);
}

export function runDevRunner(): void {
  const config = getConfig();
  const state: DevRunnerState = {
    proc: null,
    isShuttingDown: false,
    isStarting: false,
  };

  log(config, "\x1b[36m", `Watching command: ${config.command.join(" ")}`);
  log(config, "\x1b[36m", `Restart exit code: ${config.restartExitCode}`);
  log(config, "\x1b[36m", `Dev server URL: ${config.serverBaseUrl}`);
  log(config, "\x1b[36m", `Change endpoint path: ${config.changeEndpointPath}`);

  if (config.respectGitIgnore && !config.gitExecutablePath) {
    log(config, "\x1b[33m", "git not found, so .gitignore filtering is unavailable");
  }

  if (config.hintMessage) {
    log(config, "\x1b[36m", config.hintMessage);
  }

  const watchers = setupWatchers(config, state);

  start(config, state, "initial boot");

  process.on("SIGINT", () => shutdown(config, state, watchers, "SIGINT"));
  process.on("SIGTERM", () => shutdown(config, state, watchers, "SIGTERM"));
}
