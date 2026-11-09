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
  beginShutdown,
  isShuttingDown,
  tryBeginSessionStart,
} from '../../util/sessionMaintenance';

// beginShutdown() has no undo by design (a process shuts down exactly once),
// so this lives in its own file rather than sharing module state with
// sessionMaintenance.test.ts's many backup/restore scenarios.
describe('shutdown gate', () => {
  it('admits starts normally before shutdown begins', () => {
    expect(isShuttingDown()).toBe(false);
    const release = tryBeginSessionStart();
    expect(release).toBeDefined();
    release?.();
  });

  it('refuses every new session start once shutdown has begun', () => {
    beginShutdown();
    expect(isShuttingDown()).toBe(true);
    expect(tryBeginSessionStart()).toBeUndefined();
    // A second signal arriving mid-shutdown is a no-op, not an error.
    expect(() => beginShutdown()).not.toThrow();
    expect(tryBeginSessionStart()).toBeUndefined();
  });
});
