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
import { closeSession } from '../../controller/sessionController';
import { clientsArray } from '../../util/sessionUtil';

jest.mock('../../util/functions', () => ({
  callWebHook: jest.fn(),
  contactToArray: jest.fn(),
}));

const { callWebHook: mockCallWebHook } = jest.requireMock(
  '../../util/functions'
) as { callWebHook: jest.Mock };

describe('closeSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(clientsArray)) {
      delete (clientsArray as any)[key];
    }
  });

  function createResponse() {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
  }

  function makeReq(client: any) {
    (clientsArray as any)['the-session'] = client;
    return {
      session: 'the-session',
      client,
      io: { emit: jest.fn() },
      logger: { error: jest.fn() },
    };
  }

  it('resets the in-memory record even when the client is still a partial object with no close() method', async () => {
    const partialClient = { status: 'INITIALIZING', session: 'the-session' };
    const req = makeReq(partialClient);
    const res = createResponse();

    await closeSession(req as any, res as any);

    expect((clientsArray as any)['the-session'].status).toBeNull();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(req.logger.error).not.toHaveBeenCalled();
  });

  it('still resets the in-memory record and reports success when close() itself throws', async () => {
    const close = jest.fn().mockRejectedValue(new Error('browser already gone'));
    const req = makeReq({ status: 'CONNECTED', session: 'the-session', close });
    const res = createResponse();

    await closeSession(req as any, res as any);

    expect(close).toHaveBeenCalledTimes(1);
    expect((clientsArray as any)['the-session'].status).toBeNull();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(req.logger.error).toHaveBeenCalledTimes(1);
  });

  it('calls close() and emits the disconnect webhook for a fully-initialized client', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const req = makeReq({ status: 'CONNECTED', session: 'the-session', close });
    const res = createResponse();

    await closeSession(req as any, res as any);

    expect(close).toHaveBeenCalledTimes(1);
    expect(req.io.emit).toHaveBeenCalledWith('whatsapp-status', false);
    expect(mockCallWebHook).toHaveBeenCalledWith(
      req.client,
      req,
      'closesession',
      expect.objectContaining({ connected: false })
    );
    expect((clientsArray as any)['the-session'].status).toBeNull();
  });

  it('is a no-op success when the session is already null, never calling close()', async () => {
    const close = jest.fn();
    const req = makeReq({ status: null, session: 'the-session', close });
    const res = createResponse();

    await closeSession(req as any, res as any);

    expect(close).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('never calls logout or deletes the persisted token store', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const logout = jest.fn();
    const req = makeReq({ status: 'CONNECTED', session: 'the-session', close, logout });
    const res = createResponse();

    await closeSession(req as any, res as any);

    expect(logout).not.toHaveBeenCalled();
  });
});
