/*
 * Copyright 2021 WPPConnect Team
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
import fs from 'fs';
import os from 'os';
import path from 'path';

import config from '../../config';
import CreateSessionUtil from '../../util/createSessionUtil';
import {
  acquireProfileLock,
  lockFilePath,
  parseLockInfo,
  releaseAllProfileLocks,
} from '../../util/sessionProfileLock';
import { clientsArray } from '../../util/sessionUtil';

jest.mock('@wppconnect-team/wppconnect', () => ({
  create: jest.fn(),
  SocketState: { CONFLICT: 'CONFLICT' },
  StatusFind: {
    autocloseCalled: 'autocloseCalled',
    disconnectedMobile: 'disconnectedMobile',
  },
}));
jest.mock('../../controller/sessionController', () => ({
  download: jest.fn(),
}));
jest.mock('../../util/functions', () => ({
  autoDownload: jest.fn(),
  callWebHook: jest.fn(),
  startHelper: jest.fn(),
}));
jest.mock('../../util/tokenStore/factory', () => ({
  __esModule: true,
  default: jest.fn(),
}));

describe('CreateSessionUtil optional webhook listeners', function () {
  const cases = [
    {
      method: 'onCommentMessage',
      listener: 'onCommentMessage',
      register: (util: CreateSessionUtil, client: any, req: any) =>
        util.onCommentMessage(client, req),
    },
    {
      method: 'onParticipantsChanged',
      listener: 'onParticipantsChanged',
      register: (util: CreateSessionUtil, client: any, req: any) =>
        util.onParticipantsChanged(req, client),
    },
    {
      method: 'onReactionMessage',
      listener: 'onReactionMessage',
      register: (util: CreateSessionUtil, client: any, req: any) =>
        util.onReactionMessage(client, req),
    },
    {
      method: 'onRevokedMessage',
      listener: 'onRevokedMessage',
      register: (util: CreateSessionUtil, client: any, req: any) =>
        util.onRevokedMessage(client, req),
    },
    {
      method: 'onPollResponse',
      listener: 'onPollResponse',
      register: (util: CreateSessionUtil, client: any, req: any) =>
        util.onPollResponse(client, req),
    },
    {
      method: 'onLabelUpdated',
      listener: 'onUpdateLabel',
      register: (util: CreateSessionUtil, client: any, req: any) =>
        util.onLabelUpdated(client, req),
    },
  ];

  it.each(cases)(
    'registers $method without probing WAPI connection state',
    async ({ listener, register }) => {
      const util = new CreateSessionUtil();
      const client = {
        isConnected: jest
          .fn()
          .mockRejectedValue(new ReferenceError('WAPI is not defined')),
        [listener]: jest.fn().mockResolvedValue(undefined),
      };
      const req = { io: { emit: jest.fn() } };

      await expect(register(util, client, req)).resolves.toBeUndefined();
      expect(client.isConnected).not.toHaveBeenCalled();
      expect(client[listener]).toHaveBeenCalledTimes(1);
    }
  );
});

describe('CreateSessionUtil initialization ownership', () => {
  function setup() {
    const create = jest.requireMock('@wppconnect-team/wppconnect').create;
    const Factory = jest.requireMock('../../util/tokenStore/factory').default;
    Factory.mockImplementation(() => ({
      createTokenStory: () => ({
        getToken: jest.fn().mockResolvedValue({}),
        setToken: jest.fn(),
      }),
    }));
    const req = {
      body: {},
      serverOptions: { createOptions: {}, webhook: {} },
      logger: { info: jest.fn(), error: jest.fn() },
    };
    const util = new CreateSessionUtil();
    util.start = jest.fn().mockResolvedValue(undefined);
    return { create, req, util };
  }

  afterEach(() => {
    delete (clientsArray as any).stale;
    jest.clearAllMocks();
  });

  it('releases INITIALIZING after an ordinary create error so it can be retried', async () => {
    const { create, req, util } = setup();
    create.mockRejectedValue(new Error('Browser startup failed'));
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect((clientsArray as any).stale.status).toBe('CLOSED');
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('closes a late client and preserves a replacement after cancellation', async () => {
    const { create, req, util } = setup();
    const replacement = { status: 'INITIALIZING', session: 'stale' };
    const lateClient = { close: jest.fn().mockResolvedValue(undefined) };
    create.mockImplementation(async () => {
      (clientsArray as any).stale = replacement;
      return lateClient;
    });
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect(lateClient.close).toHaveBeenCalledTimes(1);
    expect((clientsArray as any).stale).toBe(replacement);
    expect(util.start).not.toHaveBeenCalled();
  });

  it('does not reset a replacement when the cancelled creation rejects', async () => {
    const { create, req, util } = setup();
    const replacement = { status: 'INITIALIZING', session: 'stale' };
    create.mockImplementation(async () => {
      (clientsArray as any).stale = replacement;
      throw new Error('Old browser failed');
    });
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect((clientsArray as any).stale).toBe(replacement);
    expect(replacement.status).toBe('INITIALIZING');
  });

  it('ignores pairing and status callbacks from a failed attempt after retry', async () => {
    const { create, req, util } = setup();
    util.exportQR = jest.fn();
    util.exportPhoneCode = jest.fn();
    let previous: any;
    let retry: any;
    create
      .mockImplementationOnce(async (options: any) => {
        previous = options;
        throw new Error('First attempt failed');
      })
      .mockImplementationOnce(async () => {
        retry = (clientsArray as any).stale;
        previous.catchQR('qr', '', 1, 'code');
        previous.catchLinkCode('phone-code');
        previous.statusFind('autocloseCalled');
        expect((clientsArray as any).stale).toBe(retry);
        expect(retry.status).toBe('INITIALIZING');
        throw new Error('Second attempt completed for the fixture');
      });
    await util.createSessionUtil(req, clientsArray, 'stale');
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect(util.exportQR).not.toHaveBeenCalled();
    expect(util.exportPhoneCode).not.toHaveBeenCalled();
  });

  it('still publishes the QR after the unpaired disconnectedMobile of a fresh page', async () => {
    const { create, req, util } = setup();
    util.exportQR = jest.fn();
    const { callWebHook } = jest.requireMock('../../util/functions');
    create.mockImplementationOnce(async (options: any) => {
      const attempt = (clientsArray as any).stale;
      // wppconnect emits this ~1s after "Session Unpaired" on a page that has
      // never been paired, before the first QR code is generated.
      options.statusFind('disconnectedMobile');
      expect((clientsArray as any).stale).toBe(attempt);
      expect(attempt.status).toBe('INITIALIZING');
      options.statusFind('notLogged');
      options.catchQR('qr', '', 1, 'code');
      throw new Error('Pairing not completed in the fixture');
    });
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect(util.exportQR).toHaveBeenCalledTimes(1);
    expect(callWebHook).toHaveBeenCalledWith(
      expect.anything(),
      req,
      'status-find',
      expect.objectContaining({ status: 'notLogged' })
    );
    expect(callWebHook).not.toHaveBeenCalledWith(
      expect.anything(),
      req,
      'status-find',
      expect.objectContaining({ status: 'disconnectedMobile' })
    );
  });

  it('reports autocloseCalled during initialization instead of throwing on close', async () => {
    const { create, req, util } = setup();
    const { callWebHook } = jest.requireMock('../../util/functions');
    create.mockImplementationOnce(async (options: any) => {
      options.statusFind('autocloseCalled');
      throw new Error('Auto Close Called');
    });
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect(callWebHook).toHaveBeenCalledWith(
      expect.anything(),
      req,
      'status-find',
      expect.objectContaining({ status: 'autocloseCalled' })
    );
  });

  it('does not start while profile cleanup holds the session reservation', async () => {
    const { create, req, util } = setup();
    (clientsArray as any).stale = { status: 'CLOSING', session: 'stale' };
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['../outside', '/outside', 'C:\\outside'])(
    'rejects initialization session %s before creating a browser',
    async (session) => {
      const { create, req, util } = setup();
      await util.createSessionUtil(req, clientsArray, session);
      expect(create).not.toHaveBeenCalled();
      expect(Object.hasOwn(clientsArray, session)).toBe(false);
      expect(req.logger.error).toHaveBeenCalled();
    }
  );

  it('closes an initialized browser when listener setup fails before allowing a retry', async () => {
    const { create, req, util } = setup();
    const runtime = { close: jest.fn().mockResolvedValue(undefined) };
    create.mockResolvedValue(runtime);
    util.start = jest
      .fn()
      .mockRejectedValue(new Error('Listener setup failed'));
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect((clientsArray as any).stale.status).toBe('CLOSED');
  });

  it('retains a runtime that failed to close for explicit cleanup', async () => {
    const { create, req, util } = setup();
    const runtime = {
      close: jest.fn().mockRejectedValue(new Error('Browser close failed')),
    };
    create.mockResolvedValue(runtime);
    util.start = jest
      .fn()
      .mockRejectedValue(new Error('Listener setup failed'));
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect((clientsArray as any).stale.status).toBe('ERROR');
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('ignores old callbacks when failed cleanup retains an ERROR owner', async () => {
    const { create, req, util } = setup();
    util.exportQR = jest.fn();
    util.exportPhoneCode = jest.fn();
    const runtime = { close: jest.fn().mockResolvedValue(undefined) };
    create.mockImplementation(async (options: any) => {
      const owner = (clientsArray as any).stale;
      owner.status = 'ERROR';
      options.catchQR('qr', '', 1, 'code');
      options.catchLinkCode('phone-code');
      options.statusFind('autocloseCalled');
      expect((clientsArray as any).stale).toBe(owner);
      expect(owner.status).toBe('ERROR');
      return runtime;
    });
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect(util.exportQR).not.toHaveBeenCalled();
    expect(util.exportPhoneCode).not.toHaveBeenCalled();
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(util.start).not.toHaveBeenCalled();
  });
});

describe('Community comment forwarding', () => {
  it('forwards the same event to Socket.IO and webhook', async () => {
    const util = new CreateSessionUtil();
    let callback: (event: unknown) => void = () => {};
    const client = {
      onCommentMessage: jest.fn((cb) => {
        callback = cb;
      }),
    };
    const req = { io: { emit: jest.fn() } };
    await util.onCommentMessage(client as any, req as any);
    const event = {
      action: 'update',
      comment: { id: 'reply', parentMsgId: 'parent', type: 'revoked' },
    };
    callback(event);
    expect(req.io.emit).toHaveBeenCalledWith('oncommentmessage', event);
    expect(
      jest.requireMock('../../util/functions').callWebHook
    ).toHaveBeenCalledWith(client, req, 'oncommentmessage', event);
  });
  it('keeps older WPPConnect clients usable', async () => {
    await expect(
      new CreateSessionUtil().onCommentMessage({} as any, {} as any)
    ).resolves.toBeUndefined();
  });
});

describe('CreateSessionUtil profile lock integration (EFS-shared userDataDir)', () => {
  let root: string;
  const originalProfileLock = { ...config.profileLock };

  function setup(customUserDataDir: string) {
    const create = jest.requireMock('@wppconnect-team/wppconnect').create;
    const Factory = jest.requireMock('../../util/tokenStore/factory').default;
    Factory.mockImplementation(() => ({
      createTokenStory: () => ({
        getToken: jest.fn().mockResolvedValue({}),
        setToken: jest.fn(),
      }),
    }));
    const req = {
      body: {},
      serverOptions: { createOptions: {}, webhook: {}, customUserDataDir },
      logger: { info: jest.fn(), error: jest.fn() },
    };
    const util = new CreateSessionUtil();
    util.start = jest.fn().mockResolvedValue(undefined);
    return { create, req, util };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpp-createsession-lock-'));
    config.profileLock.enable = true;
    config.profileLock.heartbeatIntervalMs = 50;
    config.profileLock.staleThresholdMs = 200;
  });

  afterEach(async () => {
    delete (clientsArray as any).stale;
    jest.clearAllMocks();
    Object.assign(config.profileLock, originalProfileLock);
    await releaseAllProfileLocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never calls create() when another live process already holds the real profile lock', async () => {
    const { create, req, util } = setup(root);
    // A genuine held lock (real flock), not just a JSON file that looks
    // occupied — proving the refusal comes from the kernel, not from
    // reading stale-looking metadata.
    const holder = await acquireProfileLock('stale', root, {
      heartbeatIntervalMs: 60000,
      acquireTimeoutMs: 2000,
    });
    expect(holder.acquired).toBe(true);
    if (!holder.acquired) return;

    await util.createSessionUtil(req, clientsArray, 'stale');

    expect(create).not.toHaveBeenCalled();
    expect((clientsArray as any).stale.status).toBe('ERROR');
    expect(req.logger.error).toHaveBeenCalled();

    await holder.release();
  });

  it('never calls create() even when the diagnostic heartbeat looks arbitrarily stale, as long as the real lock is still held', async () => {
    const { create, req, util } = setup(root);
    const holder = await acquireProfileLock('stale', root, {
      // Never refreshes — the diagnostic file will look ancient by the
      // time createSessionUtil checks it, which must not matter at all.
      heartbeatIntervalMs: 60 * 60 * 1000,
      acquireTimeoutMs: 2000,
    });
    expect(holder.acquired).toBe(true);
    if (!holder.acquired) return;

    await util.createSessionUtil(req, clientsArray, 'stale');

    expect(create).not.toHaveBeenCalled();
    expect((clientsArray as any).stale.status).toBe('ERROR');

    await holder.release();
  });

  it('acquires the lock, launches Chromium, and releases the lock after a clean init failure', async () => {
    const { create, req, util } = setup(root);
    create.mockRejectedValue(new Error('Browser startup failed'));

    await util.createSessionUtil(req, clientsArray, 'stale');

    expect(create).toHaveBeenCalledTimes(1);
    expect((clientsArray as any).stale.status).toBe('CLOSED');
    expect(fs.existsSync(lockFilePath(root, 'stale'))).toBe(false);
  });

  it('keeps the lock held when the runtime close() itself fails, so no second Chromium can start', async () => {
    const { create, req, util } = setup(root);
    const runtime = {
      close: jest.fn().mockRejectedValue(new Error('Browser close failed')),
    };
    create.mockResolvedValue(runtime);
    util.start = jest
      .fn()
      .mockRejectedValue(new Error('Listener setup failed'));

    await util.createSessionUtil(req, clientsArray, 'stale');

    expect((clientsArray as any).stale.status).toBe('ERROR');
    expect(fs.existsSync(lockFilePath(root, 'stale'))).toBe(true);

    // A second attempt must not even try to launch a browser while the
    // first attempt's lock (and its unclosed runtime) are still held.
    await util.createSessionUtil(req, clientsArray, 'stale');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("proceeds normally once a crashed owner's real lock has actually been released, regardless of leftover diagnostic JSON", async () => {
    const { create, req, util } = setup(root);
    // Leftover diagnostic metadata from a process that's genuinely gone —
    // no real flock behind it (nothing acquired one in this test).
    const filePath = lockFilePath(root, 'stale');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        ownerId: 'crashed-task',
        pid: 123456,
        acquiredAt: Date.now() - 100000,
        heartbeatAt: Date.now() - 100000,
      })
    );
    const runtime = { close: jest.fn().mockResolvedValue(undefined) };
    create.mockResolvedValue(runtime);

    await util.createSessionUtil(req, clientsArray, 'stale');

    expect(create).toHaveBeenCalledTimes(1);
    // util.start() is mocked as a no-op above, so status stops advancing
    // here rather than reaching CONNECTED — what this proves is that
    // initialization was allowed to proceed at all (never refused/ERRORed
    // just because the leftover JSON looked occupied).
    expect((clientsArray as any).stale.status).toBe('INITIALIZING');
  });

  it('two concurrent createSessionUtil calls for different sessions each get their own lock', async () => {
    const { create, req, util } = setup(root);
    create.mockImplementation(async () => ({
      close: jest.fn().mockResolvedValue(undefined),
    }));

    await Promise.all([
      util.createSessionUtil(req, clientsArray, 'alpha'),
      util.createSessionUtil(req, clientsArray, 'beta'),
    ]);

    expect(create).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(lockFilePath(root, 'alpha'))).toBe(true);
    expect(fs.existsSync(lockFilePath(root, 'beta'))).toBe(true);
    delete (clientsArray as any).alpha;
    delete (clientsArray as any).beta;
  });

  it('isolates the session (ERROR, best-effort close) when the real lock holder dies unexpectedly while the session is still live', async () => {
    const { create, req, util } = setup(root);
    const runtime = { close: jest.fn().mockResolvedValue(undefined) };
    create.mockResolvedValue(runtime);

    await util.createSessionUtil(req, clientsArray, 'stale');
    expect((clientsArray as any).stale.status).toBe('INITIALIZING');

    // Kill the REAL flock-holding process out from under the session —
    // simulates it being OOM-killed, crashing, or killed externally,
    // independent of anything this test or createSessionUtil did itself.
    const lockInfo = parseLockInfo(
      fs.readFileSync(lockFilePath(root, 'stale'), 'utf8')
    );
    expect(lockInfo).not.toBeNull();
    process.kill(lockInfo!.pid, 'SIGKILL');

    // No arbitrary settle guess: poll until the session is isolated or the
    // deadline is hit.
    const deadline = Date.now() + 3000;
    while (
      (clientsArray as any).stale.status !== 'ERROR' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect((clientsArray as any).stale.status).toBe('ERROR');
    expect(runtime.close).toHaveBeenCalledTimes(1);

    // The lock is genuinely gone now too (not just the in-memory session
    // state) — a brand new session can acquire it immediately.
    const second = await acquireProfileLock('stale', root, {
      heartbeatIntervalMs: 50,
      acquireTimeoutMs: 2000,
    });
    expect(second.acquired).toBe(true);
    if (second.acquired) await second.release();
  });
});
