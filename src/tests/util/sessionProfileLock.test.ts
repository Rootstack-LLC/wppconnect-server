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
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  __activeLockSessionsForTests,
  acquireProfileLock,
  isLockStale,
  lockFilePath,
  parseLockInfo,
  releaseAllProfileLocks,
  releaseProfileLockForSession,
} from '../../util/sessionProfileLock';

const SESSION = 'nerdwhats';
const OPTS = { heartbeatIntervalMs: 100, acquireTimeoutMs: 2000 };
const silentLogger = { info: () => {}, error: () => {} };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wpp-lock-test-'));
});

afterEach(async () => {
  await releaseAllProfileLocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isLockStale (diagnostic only, never authorizes anything)', () => {
  it('treats unparseable content as absent', () => {
    expect(parseLockInfo('not json')).toBeNull();
    expect(parseLockInfo('{"ownerId":"x"}')).toBeNull();
    expect(isLockStale(null, 5000)).toBe(true);
  });

  it('is "stale" by the clock alone once past the threshold — informational only', () => {
    const info = { ownerId: 'a', pid: 1, acquiredAt: 0, heartbeatAt: 1000 };
    expect(isLockStale(info, 5000, 1000 + 4999)).toBe(false);
    expect(isLockStale(info, 5000, 1000 + 5001)).toBe(true);
  });
});

describe('session authentication data is never touched (lock file is a separate, isolated marker)', () => {
  it('leaves WhatsApp auth/profile files in the session directory untouched across repeated acquire/release cycles', async () => {
    const dir = path.resolve(root, SESSION);
    fs.mkdirSync(dir, { recursive: true });
    // Stand-ins for what a real Chromium profile holds the WhatsApp Web
    // session in (localStorage/IndexedDB backing files, cookies, etc).
    const authFiles = [
      'Default/Local Storage/leveldb/000003.log',
      'Default/Cookies',
    ];
    for (const f of authFiles) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), 'auth-data-unchanged');
    }

    for (let i = 0; i < 3; i++) {
      const result = await acquireProfileLock(SESSION, root, {
        ...OPTS,
        logger: silentLogger,
      });
      expect(result.acquired).toBe(true);
      if (result.acquired) await result.release();
    }

    for (const f of authFiles) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe(
        'auth-data-unchanged'
      );
    }
  });
});

describe('acquireProfileLock (same-process)', () => {
  it('acquires immediately when nothing holds the flock, writing diagnostic info', async () => {
    const result = await acquireProfileLock(SESSION, root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(result.acquired).toBe(true);

    const info = parseLockInfo(
      fs.readFileSync(lockFilePath(root, SESSION), 'utf8')
    );
    expect(info?.pid).toBeGreaterThan(0);

    if (result.acquired) await result.release();
  });

  it("never deletes or writes to Chromium's own Singleton* files", async () => {
    const dir = path.resolve(root, SESSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SingletonLock'), 'chromium-owned');
    fs.writeFileSync(path.join(dir, 'SingletonCookie'), 'chromium-owned');

    const result = await acquireProfileLock(SESSION, root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(result.acquired).toBe(true);
    if (result.acquired) await result.release();

    expect(fs.readFileSync(path.join(dir, 'SingletonLock'), 'utf8')).toBe(
      'chromium-owned'
    );
    expect(fs.readFileSync(path.join(dir, 'SingletonCookie'), 'utf8')).toBe(
      'chromium-owned'
    );
  });

  it('releasing is a safe no-op when this process holds nothing for the session', async () => {
    await expect(
      releaseProfileLockForSession(SESSION)
    ).resolves.toBeUndefined();
  });

  it('each release() closure only ever touches the exact process it itself spawned, even if called repeatedly', async () => {
    const first = await acquireProfileLock(SESSION, root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    await first.release();
    await first.release(); // idempotent — a second call is a safe no-op

    const second = await acquireProfileLock(SESSION, root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(second.acquired).toBe(true);
    if (!second.acquired) return;

    // The first closure is already fully spent — calling it again must
    // never reach into the registry and disturb the second attempt's
    // currently-held lock.
    await first.release();
    expect(__activeLockSessionsForTests()).toContain(SESSION);

    await second.release();
  });

  it('a close/logout route using releaseProfileLockForSession by name releases whichever attempt this process currently holds', async () => {
    const result = await acquireProfileLock(SESSION, root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(result.acquired).toBe(true);
    await releaseProfileLockForSession(SESSION);
    expect(__activeLockSessionsForTests()).not.toContain(SESSION);

    // The flock is genuinely free again — not just "forgotten" bookkeeping.
    const again = await acquireProfileLock(SESSION, root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(again.acquired).toBe(true);
    if (again.acquired) await again.release();
  });
});

describe('a live owner whose heartbeat lags past the stale threshold is never reclaimed', () => {
  it('a second acquire refuses outright while the real flock is still held, however old the heartbeat looks', async () => {
    const holder = await acquireProfileLock(SESSION, root, {
      heartbeatIntervalMs: 60 * 60 * 1000, // effectively never refreshes
      acquireTimeoutMs: 2000,
      logger: silentLogger,
    });
    expect(holder.acquired).toBe(true);
    if (!holder.acquired) return;

    // Back-date the diagnostic heartbeat well past any sane stale threshold
    // (45s) without touching the real flock at all.
    const filePath = lockFilePath(root, SESSION);
    const info = parseLockInfo(fs.readFileSync(filePath, 'utf8'))!;
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...info, heartbeatAt: Date.now() - 10 * 60 * 1000 })
    );
    expect(
      isLockStale(parseLockInfo(fs.readFileSync(filePath, 'utf8')), 45000)
    ).toBe(true);

    const second = await acquireProfileLock(SESSION, root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toBe('locked');

    await holder.release();
  });
});

describe('a process dying mid-write of the diagnostic lock file', () => {
  it('a corrupt/truncated metadata file never causes an incorrect acquire/refuse decision', async () => {
    const filePath = lockFilePath(root, SESSION);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"ownerId":"trunc'); // truncated JSON, no flock held

    const result = await acquireProfileLock(SESSION, root, {
      ...OPTS,
      logger: silentLogger,
    });
    // Nobody actually holds the flock — the garbage content is irrelevant.
    expect(result.acquired).toBe(true);
    if (result.acquired) await result.release();
  });
});

describe('concurrent acquisition (same process, Promise.all)', () => {
  it('only one of many simultaneous attempts for the same session wins', async () => {
    const attempts = Array.from({ length: 10 }, () =>
      acquireProfileLock(SESSION, root, { ...OPTS, logger: silentLogger })
    );
    const results = await Promise.all(attempts);
    const winners = results.filter((r) => r.acquired);
    expect(winners.length).toBe(1);
    if (winners[0]?.acquired) await winners[0].release();
  });
});

describe('SIGTERM mid-initialize / mid-close (releaseAllProfileLocks)', () => {
  it('releases a lock for a session still mid-initialize — never reached a per-session registry', async () => {
    const result = await acquireProfileLock('mid-init-session', root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(result.acquired).toBe(true);
    expect(__activeLockSessionsForTests()).toContain('mid-init-session');

    // Simulates SIGTERM arriving before createSessionUtil's own init flow
    // ever registers this session anywhere else — the shutdown sweep must
    // still find and release it by going straight to this module's own
    // registry instead of relying on being told the session name.
    await releaseAllProfileLocks();

    expect(__activeLockSessionsForTests()).not.toContain('mid-init-session');
    const reacquired = await acquireProfileLock('mid-init-session', root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(reacquired.acquired).toBe(true);
    if (reacquired.acquired) await reacquired.release();
  });

  it('a shutdown sweep racing an explicit close() for the same session never double-frees or throws', async () => {
    const result = await acquireProfileLock(SESSION, root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    // SIGTERM arrives in the middle of an explicit user-initiated close —
    // both paths try to release the very same session concurrently.
    await expect(
      Promise.all([result.release(), releaseAllProfileLocks()])
    ).resolves.toBeDefined();

    expect(__activeLockSessionsForTests()).not.toContain(SESSION);
    const after = await acquireProfileLock(SESSION, root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(after.acquired).toBe(true);
    if (after.acquired) await after.release();
  });

  it('releases every held lock across multiple sessions in one sweep', async () => {
    const a = await acquireProfileLock('session-a', root, {
      ...OPTS,
      logger: silentLogger,
    });
    const b = await acquireProfileLock('session-b', root, {
      ...OPTS,
      logger: silentLogger,
    });
    expect(a.acquired && b.acquired).toBe(true);

    await releaseAllProfileLocks();

    expect(__activeLockSessionsForTests()).toEqual([]);
  });
});

describe('cross-process exclusion (real, independent Node processes)', () => {
  const workerPath = path.resolve(__dirname, 'fixtures/profileLockWorker.ts');
  const tsx = path.resolve(__dirname, '../../../node_modules/.bin/tsx');

  function runWorker(
    session: string,
    heartbeatMs: number,
    acquireTimeoutMs: number,
    holdMs: number | 'forever' | 'forever-with-chromium'
  ): { proc: ChildProcess; output: Promise<string[]>; lines: string[] } {
    const proc = spawn(
      tsx,
      [
        workerPath,
        root,
        session,
        String(heartbeatMs),
        String(acquireTimeoutMs),
        String(holdMs),
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    // Shared accumulator, exposed below: a *second* listener attached later
    // (e.g. to wait for a line that may have already streamed past) would
    // simply never see data a first listener already consumed — polling
    // this live array instead sidesteps that "missed event" trap entirely.
    const lines: string[] = [];
    proc.stdout?.on('data', (chunk: Buffer) => {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    });
    const output = new Promise<string[]>((resolve) => {
      proc.once('exit', () => resolve(lines));
    });
    return { proc, output, lines };
  }

  /** Polls `lines` (kept live by runWorker's own listener) until one
   * matches `pattern`, instead of attaching a fresh stream listener that
   * could miss a line already emitted before it was attached. */
  async function waitForLine(
    lines: string[],
    pattern: RegExp
  ): Promise<string> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = lines.find((line) => pattern.test(line));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for a line matching ${pattern}`);
  }

  /** Resolves with the worker's own PID once it prints `ACQUIRED pid=<n>` —
   * the PID of the actual Node process that called acquireProfileLock, not
   * the `tsx` wrapper spawn() returns (same distinction that matters in
   * production: Node's own PID, which is what ECS/the OS can SIGKILL
   * independently of its container). */
  function waitForAcquiredPid(proc: ChildProcess): Promise<number> {
    return new Promise((resolve) => {
      proc.stdout?.on('data', (chunk: Buffer) => {
        const match = chunk.toString('utf8').match(/ACQUIRED pid=(\d+)/);
        if (match) resolve(Number(match[1]));
      });
    });
  }

  function killTree(proc: ChildProcess): void {
    if (proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    }
  }

  /** Counts live `flock`/`cat` processes anywhere on the host whose command
   * line references this test's own tmp root — i.e. orphans this suite
   * itself produced, not unrelated processes. */
  function countLockHolderProcesses(): number {
    try {
      const out = execSync(
        `ps -eo args | grep -F ${JSON.stringify(root)} | grep -v grep`,
        {
          encoding: 'utf8',
        }
      );
      return out.split('\n').filter(Boolean).length;
    } catch {
      return 0; // grep exits 1 when nothing matches — that's zero, not an error
    }
  }

  it('two independent Node processes opening the same session — exactly one acquires', async () => {
    const a = runWorker(SESSION, 100, 2000, 300);
    // Give A a head start so it reliably wins the race deterministically
    // (the point under test is mutual exclusion, not fairness/ordering).
    await new Promise((resolve) => setTimeout(resolve, 100));
    const b = runWorker(SESSION, 100, 2000, 300);

    const [linesA, linesB] = await Promise.all([a.output, b.output]);

    expect(linesA[0]).toMatch(/^ACQUIRED pid=\d+$/);
    expect(linesB[0]).toBe('REFUSED');
    expect(linesA).toContain('RELEASED');
  }, 15000);

  it('releases only after the simulated Chromium close() resolves — RELEASED never printed before the hold completes', async () => {
    const start = Date.now();
    const a = runWorker(SESSION, 100, 2000, 200);
    const lines = await a.output;
    expect(lines[0]).toMatch(/^ACQUIRED pid=\d+$/);
    expect(lines[1]).toBe('RELEASED');
    // The worker's own release() call happens strictly after its 200ms
    // "Chromium is still closing" simulation — a release printed sooner
    // would mean the lock let go before the caller actually confirmed
    // closure.
    expect(Date.now() - start).toBeGreaterThanOrEqual(190);
  }, 15000);

  it('after the real owner releases, a second independent process can then acquire', async () => {
    const a = runWorker(SESSION, 100, 2000, 200);
    const linesA = await a.output;
    expect(linesA[0]).toMatch(/^ACQUIRED pid=\d+$/);
    expect(linesA[1]).toBe('RELEASED');

    const b = runWorker(SESSION, 100, 2000, 50);
    const linesB = await b.output;
    expect(linesB[0]).toMatch(/^ACQUIRED pid=\d+$/);
    expect(linesB[1]).toBe('RELEASED');
  }, 15000);

  it(
    'a crashed process (whole tree killed, no release()) frees the flock immediately for the next process — ' +
      'proves exclusion comes from the kernel, not from waiting out a timer',
    async () => {
      const crasher = runWorker(SESSION, 100, 2000, 'forever');
      await waitForAcquiredPid(crasher.proc);

      // While the crasher is still alive, a second process must be refused —
      // even though its diagnostic heartbeat would look arbitrarily old to
      // isLockStale() given enough wall-clock time.
      const whileAlive = runWorker(SESSION, 100, 500, 0);
      const linesWhileAlive = await whileAlive.output;
      expect(linesWhileAlive[0]).toBe('REFUSED');

      // Simulate the whole container dying: kill the crasher's entire
      // process group (it and its own flock(1)/cat child), not just the
      // top-level worker PID.
      killTree(crasher.proc);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const after = runWorker(SESSION, 100, 2000, 50);
      const linesAfter = await after.output;
      expect(linesAfter[0]).toMatch(/^ACQUIRED pid=\d+$/);
    },
    15000
  );

  it(
    'Node killed with SIGKILL (its OWN pid only, process group left alone) still frees the lock immediately — ' +
      'no orphaned flock/cat process survives, proving the pipe-based parent-death link works',
    async () => {
      const victim = runWorker(SESSION, 100, 2000, 'forever');
      const nodePid = await waitForAcquiredPid(victim.proc);

      expect(countLockHolderProcesses()).toBeGreaterThan(0);

      // The key difference from the "crashed process" test above: this
      // kills ONLY the exact Node PID that called acquireProfileLock —
      // never its process group, never a parent wrapper — exactly the
      // "Node itself dies, container keeps running" scenario.
      process.kill(nodePid, 'SIGKILL');

      // No arbitrary settle time: poll briefly for the orphan count to hit
      // zero rather than asserting after a guessed delay.
      const deadline = Date.now() + 3000;
      while (countLockHolderProcesses() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(countLockHolderProcesses()).toBe(0);

      // Mutual exclusion survives the restart: a fresh process for the same
      // session acquires immediately, with nothing left over to refuse it.
      const after = runWorker(SESSION, 100, 2000, 50);
      const linesAfter = await after.output;
      expect(linesAfter[0]).toMatch(/^ACQUIRED pid=\d+$/);
    },
    15000
  );

  it('no orphaned flock/cat processes survive a full sequence of normal use, a crash, and a SIGKILL-only death', async () => {
    const normal = runWorker(SESSION, 100, 2000, 100);
    await normal.output;

    const crasher = runWorker('crash-session', 100, 2000, 'forever');
    await waitForAcquiredPid(crasher.proc);
    killTree(crasher.proc);

    const sigkilled = runWorker('sigkill-session', 100, 2000, 'forever');
    const sigkilledPid = await waitForAcquiredPid(sigkilled.proc);
    process.kill(sigkilledPid, 'SIGKILL');

    const deadline = Date.now() + 3000;
    while (countLockHolderProcesses() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(countLockHolderProcesses()).toBe(0);
  }, 15000);

  /** Parses `HOLDER pid=<n> CHROMIUM pid=<n>` out of a worker's accumulated
   * output lines (see waitForLine — polls the live array rather than
   * attaching a fresh, possibly-too-late stream listener). */
  async function waitForHolderAndChromium(
    lines: string[]
  ): Promise<{ holder: number; chromium: number }> {
    const line = await waitForLine(lines, /HOLDER pid=\d+ CHROMIUM pid=\d+/);
    const match = line.match(/HOLDER pid=(\d+) CHROMIUM pid=(\d+)/)!;
    return { holder: Number(match[1]), chromium: Number(match[2]) };
  }

  async function waitForAcquiredPidFrom(lines: string[]): Promise<number> {
    const line = await waitForLine(lines, /^ACQUIRED pid=\d+$/);
    return Number(line.match(/ACQUIRED pid=(\d+)/)![1]);
  }

  it(
    'Chromium (a real stand-in child process, not the lock holder) survives Node being SIGKILLed — ' +
      'and the lock correctly stays held, then force-kills Chromium, instead of releasing while it is still live',
    async () => {
      const worker = runWorker(SESSION, 100, 2000, 'forever-with-chromium');
      const nodePid = await waitForAcquiredPidFrom(worker.lines);
      const { holder, chromium } = await waitForHolderAndChromium(worker.lines);

      // Kill ONLY the Node worker — neither the holder nor the stand-in
      // Chromium are touched directly, mirroring a real OOM-kill of just
      // the Node process inside an otherwise-still-running container.
      process.kill(nodePid, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(() => process.kill(chromium, 0)).not.toThrow(); // still alive
      const whileAlive = runWorker(SESSION, 100, 500, 0);
      expect((await whileAlive.output)[0]).toBe('REFUSED');

      // Past the fixture's 3s orphanKillAfterS, the holder (still running
      // independently of the now-dead Node) force-kills the stand-in
      // Chromium itself and only then releases.
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        try {
          process.kill(chromium, 0);
        } catch {
          break; // ESRCH — Chromium is confirmed gone
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(() => process.kill(chromium, 0)).toThrow();
      expect(() => process.kill(holder, 0)).toThrow();

      const after = runWorker(SESSION, 100, 2000, 50);
      expect((await after.output)[0]).toMatch(/^ACQUIRED pid=\d+$/);
    },
    15000
  );

  it(
    'losing the holder process itself (SIGTERM, Node and Chromium both still alive) still refuses a second ' +
      'process while Chromium is live, then force-kills it and releases — proves the guard also protects ' +
      'against something other than this codebase killing the holder directly',
    async () => {
      const worker = runWorker(SESSION, 100, 2000, 'forever-with-chromium');
      const { holder, chromium } = await waitForHolderAndChromium(worker.lines);

      // SIGTERM (catchable) sent directly to the holder — not via this
      // module's own release(), not via Node dying. Node and the stand-in
      // Chromium are both left completely alone.
      process.kill(holder, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(() => process.kill(chromium, 0)).not.toThrow();
      const whileAlive = runWorker(SESSION, 100, 500, 0);
      expect((await whileAlive.output)[0]).toBe('REFUSED');

      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        try {
          process.kill(chromium, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(() => process.kill(chromium, 0)).toThrow();

      killTree(worker.proc);
      const after = runWorker(SESSION, 100, 2000, 50);
      expect((await after.output)[0]).toMatch(/^ACQUIRED pid=\d+$/);
    },
    15000
  );

  it(
    'documents a known, unfixable limit: SIGKILL aimed at the holder PID itself (not Node, not the ' +
      'container) cannot be intercepted by any process on any Unix system, so the lock releases immediately ' +
      'even if Chromium is still alive — this is a kernel guarantee, not a gap in this design',
    async () => {
      const worker = runWorker(SESSION, 100, 2000, 'forever-with-chromium');
      const { holder, chromium } = await waitForHolderAndChromium(worker.lines);

      process.kill(holder, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(() => process.kill(holder, 0)).toThrow(); // gone immediately
      expect(() => process.kill(chromium, 0)).not.toThrow(); // still alive

      const second = runWorker(SESSION, 100, 2000, 50);
      // Acquires immediately — nothing could have prevented this once the
      // exact holder PID was SIGKILLed directly.
      expect((await second.output)[0]).toMatch(/^ACQUIRED pid=\d+$/);

      process.kill(chromium, 'SIGKILL');
      // The original worker's own Node process is still running (it only
      // ever awaits forever) — only the holder and the stand-in Chromium
      // were targeted above, so it must be cleaned up separately here.
      killTree(worker.proc);
    },
    15000
  );
});
