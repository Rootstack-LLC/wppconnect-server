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
// Standalone worker spawned as a REAL, separate OS process by
// sessionProfileLock.test.ts's cross-process suite — proves exclusion holds
// across process boundaries, not just across concurrent promises inside one
// Jest worker.
//
// argv: [userDataDir, session, heartbeatIntervalMs, acquireTimeoutMs, holdMs]
// holdMs === 'forever': acquire and then hang (never release), so the test
// can kill this process (or its whole tree) to simulate a crash.
// holdMs === 'forever-with-chromium': like 'forever', but also spawns a
// stand-in "Chromium" (a `sleep` whose argv carries a real
// --user-data-dir=<profile> marker) as a direct child of THIS worker —
// mirrors Puppeteer's real process shape, where Chromium is a sibling of
// the lock holder, not its child, and survives this worker's own death.
//
// Prints to stdout:
//   REFUSED                       — the kernel lock was already held
//   ACQUIRED pid=<this process>    — lets the test target *this exact PID*
//                                     with a single-process SIGKILL, as
//                                     opposed to killing the whole tree/group
//   HOLDER pid=<n> CHROMIUM pid=<n> — ('forever-with-chromium' only) lets
//                                     the test target the real flock-holder
//                                     process and the stand-in browser
//                                     directly, independent of this worker
//   RELEASED                      — only after result.release() resolved,
//                                     i.e. only after Chromium's stand-in
//                                     was confirmed closed
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  acquireProfileLock,
  lockFilePath,
  parseLockInfo,
} from '../../../util/sessionProfileLock';

async function main() {
  const [userDataDir, session, heartbeatMs, acquireTimeoutMs, holdMsRaw] =
    process.argv.slice(2);

  const result = await acquireProfileLock(session, userDataDir, {
    heartbeatIntervalMs: Number(heartbeatMs),
    acquireTimeoutMs: Number(acquireTimeoutMs),
    orphanKillAfterS: 3,
  });

  if (!result.acquired) {
    console.log('REFUSED');
    process.exit(0);
  }

  console.log(`ACQUIRED pid=${process.pid}`);

  if (holdMsRaw === 'forever-with-chromium') {
    const dir = path.resolve(userDataDir, session);
    const chromium = spawn('sh', [
      '-c',
      'sleep 300',
      'chromiumfake',
      `--user-data-dir=${dir}`,
    ]);
    const info = parseLockInfo(
      fs.readFileSync(lockFilePath(userDataDir, session), 'utf8')
    );
    console.log(`HOLDER pid=${info?.pid} CHROMIUM pid=${chromium.pid}`);
    await new Promise(() => {});
    return;
  }

  if (holdMsRaw === 'forever') {
    // Deliberately never resolves — the test kills this process (or tree)
    // from the outside to simulate a crash.
    await new Promise(() => {});
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, Number(holdMsRaw)));
  await result.release();
  console.log('RELEASED');
  process.exit(0);
}

main();
