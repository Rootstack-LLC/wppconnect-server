/*
 * Copyright 2026 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  releaseAllProfileLocks,
  releaseProfileLockForSession,
} from './sessionProfileLock';

export interface DrainableSession {
  name: string;
  close: () => Promise<void>;
}

export interface DrainLogger {
  info: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

/**
 * Closes every session's browser/socket before the process exits, so
 * Chromium gets a real chance to release its own SingletonLock instead of
 * being SIGKILLed by the container runtime once ECS's stop timeout elapses.
 * Bounded by `timeoutMs` so a single hung session can never consume the
 * whole grace period and get every other session killed uncleanly too.
 */
export async function drainSessions(
  sessions: DrainableSession[],
  timeoutMs: number,
  logger: DrainLogger
): Promise<void> {
  const closeOne = async (session: DrainableSession) => {
    try {
      await session.close();
    } catch (error) {
      logger.error(`[${session.name}] Error closing during shutdown`, error);
    } finally {
      await releaseProfileLockForSession(session.name).catch(() => {});
    }
  };

  const allClosed = Promise.allSettled(sessions.map(closeOne));
  let timer: NodeJS.Timeout;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });

  let result: 'closed' | 'timeout';
  try {
    result = await Promise.race([
      allClosed.then(() => 'closed' as const),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer!);
  }

  if (result === 'timeout') {
    logger.error(
      `Shutdown timeout (${timeoutMs}ms) reached with sessions still closing; ` +
        'proceeding so the process can exit within ECS stopTimeout.'
    );
  } else {
    logger.info(`Closed ${sessions.length} session(s) for shutdown`);
  }
}

export interface DrainableSessionSource {
  list: () => Array<{
    name: string;
    adapter?: { session: { close: () => Promise<void> } };
  }>;
}

export interface ShutdownHandlerDeps {
  app: { close: () => Promise<unknown> };
  sessionManager: DrainableSessionSource;
  logger: DrainLogger;
  timeoutMs: number;
  beginShutdown: () => void;
}

/**
 * Builds the SIGTERM/SIGINT handler without touching `process` itself, so
 * tests can invoke it directly instead of sending real OS signals. Idempotent
 * — a second signal arriving mid-drain (ECS or an operator being impatient)
 * does not start a second, overlapping drain.
 */
export function createShutdownHandler(
  deps: ShutdownHandlerDeps
): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    deps.beginShutdown();
    deps.logger.info('Received shutdown signal, draining sessions...');

    const sessions: DrainableSession[] = deps.sessionManager
      .list()
      .filter((handle) => handle.adapter)
      .map((handle) => ({
        name: handle.name,
        close: () => handle.adapter!.session.close(),
      }));

    await drainSessions(sessions, deps.timeoutMs, deps.logger);

    // Catches locks drainSessions cannot see — a session still mid-create()
    // when the signal arrived never reached the SessionManager, so it was
    // never in `sessions` above. Releasing it here hands the profile to the
    // next task immediately instead of waiting on the container's own kill.
    await releaseAllProfileLocks().catch((error) =>
      deps.logger.error('Error releasing in-flight profile locks', error)
    );

    await deps.app
      .close()
      .catch((error) => deps.logger.error('Error closing server', error));
  };
}
