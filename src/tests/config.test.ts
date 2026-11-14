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

// webhook.readMessage drives an automatic client.sendSeen() call for every
// inbound message delivered over the webhook (see src/util/functions.ts,
// callWebHook) -- a webhook consumer has no per-request way to opt out of
// this, only this server-wide setting. It must default to false: a
// receiver that only wants to be notified of a message, or only reads its
// own history from its own database, must never cause WhatsApp itself to
// be marked "seen" as a side effect.

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

function loadConfig() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../config').default;
}

it('defaults webhook.readMessage to false when WEBHOOK_READ_MESSAGE is unset', () => {
  delete process.env.WEBHOOK_READ_MESSAGE;

  expect(loadConfig().webhook.readMessage).toBe(false);
});

it('keeps webhook.readMessage false for any value other than the literal string "true"', () => {
  for (const value of ['false', '0', 'no', '']) {
    process.env.WEBHOOK_READ_MESSAGE = value;
    expect(loadConfig().webhook.readMessage).toBe(false);
  }
});

it('only enables webhook.readMessage when WEBHOOK_READ_MESSAGE is explicitly "true"', () => {
  process.env.WEBHOOK_READ_MESSAGE = 'true';

  expect(loadConfig().webhook.readMessage).toBe(true);
});

it('accepts WEBHOOK_READ_MESSAGE case-insensitively', () => {
  process.env.WEBHOOK_READ_MESSAGE = 'TRUE';

  expect(loadConfig().webhook.readMessage).toBe(true);
});
