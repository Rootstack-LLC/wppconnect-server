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
import CreateSessionUtil from '../../util/createSessionUtil';
import { clientsArray } from '../../util/sessionUtil';
import { create as mockCreate } from '@wppconnect-team/wppconnect';

jest.mock('@wppconnect-team/wppconnect', () => ({
  create: jest.fn(),
  SocketState: { CONFLICT: 'CONFLICT' },
  StatusFind: {},
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
  default: jest.fn().mockImplementation(() => ({
    createTokenStory: () => ({
      getToken: jest.fn().mockResolvedValue({}),
      setToken: jest.fn(),
    }),
  })),
}));

describe('CreateSessionUtil optional webhook listeners', function () {
  const cases = [
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

describe('CreateSessionUtil initialization failure recovery', function () {
  function makeReq(overrides: any = {}) {
    return {
      body: {},
      logger: { error: jest.fn(), info: jest.fn() },
      serverOptions: {
        createOptions: {},
        webhook: {},
      },
      io: { emit: jest.fn() },
      ...overrides,
    };
  }

  afterEach(() => {
    for (const key of Object.keys(clientsArray)) {
      delete (clientsArray as any)[key];
    }
    jest.clearAllMocks();
  });

  it('resets a session stuck in INITIALIZING to CLOSED after a TimeoutError', async () => {
    const util = new CreateSessionUtil();
    const error = new Error('timed out');
    error.name = 'TimeoutError';
    (mockCreate as jest.Mock).mockRejectedValue(error);

    await util.createSessionUtil(makeReq(), clientsArray, 'session-a');

    expect((clientsArray as any)['session-a'].status).toBe('CLOSED');
  });

  it('also resets to CLOSED after a plain, generic Error — not just TimeoutError', async () => {
    const util = new CreateSessionUtil();
    (mockCreate as jest.Mock).mockRejectedValue(new Error('browser crashed'));

    await util.createSessionUtil(makeReq(), clientsArray, 'session-b');

    expect((clientsArray as any)['session-b'].status).toBe('CLOSED');
  });

  it('also resets to CLOSED when the rejection is not an Error instance at all', async () => {
    const util = new CreateSessionUtil();
    (mockCreate as jest.Mock).mockRejectedValue('plain string rejection');

    await util.createSessionUtil(makeReq(), clientsArray, 'session-c');

    expect((clientsArray as any)['session-c'].status).toBe('CLOSED');
  });

  it('a retry with the same sessionId succeeds once the prior attempt is CLOSED', async () => {
    const util = new CreateSessionUtil();
    (mockCreate as jest.Mock).mockRejectedValueOnce(new Error('first attempt fails'));
    await util.createSessionUtil(makeReq(), clientsArray, 'session-retry');
    expect((clientsArray as any)['session-retry'].status).toBe('CLOSED');

    const secondClient = { close: jest.fn().mockResolvedValue(undefined) };
    (mockCreate as jest.Mock).mockResolvedValueOnce(secondClient);
    await util.createSessionUtil(makeReq(), clientsArray, 'session-retry');

    expect((clientsArray as any)['session-retry']).toBe(secondClient);
  });

  it('two different sessionIds never affect each other', async () => {
    const util = new CreateSessionUtil();
    const clientY = { close: jest.fn().mockResolvedValue(undefined) };
    (mockCreate as jest.Mock).mockImplementation((config: any) => {
      if (config.session === 'session-x') {
        return Promise.reject(new Error('session-x fails'));
      }
      return Promise.resolve(clientY);
    });

    await Promise.all([
      util.createSessionUtil(makeReq(), clientsArray, 'session-x'),
      util.createSessionUtil(makeReq(), clientsArray, 'session-y'),
    ]);

    expect((clientsArray as any)['session-x'].status).toBe('CLOSED');
    expect((clientsArray as any)['session-y']).toBe(clientY);
  });

  it('a late resolution from an abandoned attempt never clobbers a session already superseded by close-session', async () => {
    const util = new CreateSessionUtil();
    let resolveCreate: (value: any) => void;
    (mockCreate as jest.Mock).mockReturnValue(
      new Promise(resolve => {
        resolveCreate = resolve;
      })
    );

    const pending = util.createSessionUtil(makeReq(), clientsArray, 'session-stale');
    expect((clientsArray as any)['session-stale'].status).toBe('INITIALIZING');

    (clientsArray as any)['session-stale'] = { status: null, session: 'session-stale' };

    const staleClient = { close: jest.fn().mockResolvedValue(undefined) };
    resolveCreate!(staleClient);
    await pending;

    expect((clientsArray as any)['session-stale'].status).toBeNull();
    expect((clientsArray as any)['session-stale']).not.toBe(staleClient);
    expect(staleClient.close).toHaveBeenCalledTimes(1);
  });
});
