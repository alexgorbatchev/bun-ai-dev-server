export const FIXTURE_HEALTH_ENDPOINT_PATH = '/__fixture__/health';
export const FIXTURE_WATCH_FILE_NAME = 'watched.ts';

export type FixtureHealthResponse = {
  processId: number;
  startedAt: number;
};
