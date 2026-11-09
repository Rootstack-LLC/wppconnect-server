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
  createShutdownHandler,
  drainSessions,
} from '../../util/shutdownManager';

jest.mock('../../util/sessionProfileLock', () => ({
  releaseProfileLockForSession: jest.fn().mockResolvedValue(undefined),
  releaseAllProfileLocks: jest.fn().mockResolvedValue(undefined),
}));

const { releaseProfileLockForSession, releaseAllProfileLocks } =
  jest.requireMock('../../util/sessionProfileLock');

const silentLogger = { info: jest.fn(), error: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('drainSessions', () => {
  it('closes every session and releases its profile lock', async () => {
    const closeA = jest.fn().mockResolvedValue(undefined);
    const closeB = jest.fn().mockResolvedValue(undefined);
    await drainSessions(
      [
        { name: 'a', close: closeA },
        { name: 'b', close: closeB },
      ],
      5000,
      silentLogger
    );
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(releaseProfileLockForSession).toHaveBeenCalledWith('a');
    expect(releaseProfileLockForSession).toHaveBeenCalledWith('b');
  });

  it('a failing session close does not prevent the others from draining', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('boom'));
    const ok = jest.fn().mockResolvedValue(undefined);
    await drainSessions(
      [
        { name: 'failing', close: failing },
        { name: 'ok', close: ok },
      ],
      5000,
      silentLogger
    );
    expect(ok).toHaveBeenCalledTimes(1);
    expect(silentLogger.error).toHaveBeenCalled();
    // Even a session whose close() rejected still gets its lock released —
    // the profile is presumed gone either way, not left claimed forever.
    expect(releaseProfileLockForSession).toHaveBeenCalledWith('failing');
  });

  it('gives up waiting once the timeout elapses, instead of hanging past the ECS stop timeout', async () => {
    let releaseHang: () => void = () => {};
    const hung = jest.fn(
      () => new Promise<void>((resolve) => (releaseHang = resolve))
    );
    const start = Date.now();
    await drainSessions([{ name: 'hung', close: hung }], 30, silentLogger);
    expect(Date.now() - start).toBeLessThan(500);
    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Shutdown timeout')
    );
    releaseHang();
  });

  it('does nothing and does not throw when there are no sessions', async () => {
    await expect(
      drainSessions([], 5000, silentLogger)
    ).resolves.toBeUndefined();
  });
});

describe('createShutdownHandler', () => {
  function setup(sessions: any[] = []) {
    const app = { close: jest.fn().mockResolvedValue(undefined) };
    const sessionManager = { list: jest.fn().mockReturnValue(sessions) };
    const beginShutdown = jest.fn();
    const handler = createShutdownHandler({
      app,
      sessionManager,
      logger: silentLogger,
      timeoutMs: 5000,
      beginShutdown,
    });
    return { app, sessionManager, beginShutdown, handler };
  }

  it('marks the process as shutting down before draining anything', async () => {
    const { beginShutdown, handler } = setup();
    await handler();
    expect(beginShutdown).toHaveBeenCalledTimes(1);
  });

  it('closes every session handle that has an adapter and then the server', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const { app, handler } = setup([
      { name: 'live', adapter: { session: { close } } },
    ]);
    await handler();
    expect(close).toHaveBeenCalledTimes(1);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('skips handles with no adapter (never-started sessions) without throwing', async () => {
    const { app, handler } = setup([{ name: 'empty' }]);
    await expect(handler()).resolves.toBeUndefined();
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('a second signal mid-drain does not start an overlapping drain', async () => {
    let resolveClose: () => void = () => {};
    const close = jest.fn(
      () => new Promise<void>((resolve) => (resolveClose = resolve))
    );
    const { sessionManager, handler } = setup([
      { name: 'slow', adapter: { session: { close } } },
    ]);
    const first = handler();
    const second = handler();
    expect(sessionManager.list).toHaveBeenCalledTimes(1);
    resolveClose();
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('releases in-flight profile locks for sessions still mid-initialize — SIGTERM arriving before createSessionUtil ever reaches the SessionManager', async () => {
    // A session mid-create() has no SessionManager handle yet (see
    // createSessionUtil.ts — it's only registered after create() resolves),
    // so drainSessions() above can never find or close it by name. This is
    // what closes that gap: a plain sweep of whatever this process still
    // holds a real lock for, independent of SessionManager registration.
    const { handler } = setup([]); // nothing registered yet
    await handler();
    expect(releaseAllProfileLocks).toHaveBeenCalledTimes(1);
  });

  it('still closes the server even if releasing in-flight locks fails', async () => {
    releaseAllProfileLocks.mockRejectedValueOnce(
      new Error('flock binary missing')
    );
    const { app, handler } = setup([]);
    await expect(handler()).resolves.toBeUndefined();
    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
