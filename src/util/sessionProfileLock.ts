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
import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Coordinates access to a session's Chromium profile directory across
 * processes that can share it over a network filesystem (EFS), without ever
 * touching Chromium's own SingletonLock/SingletonCookie/SingletonSocket
 * files. Those stay exactly as Chromium leaves them; this writes and reads
 * only its own marker file (`LOCK_FILE_NAME`) next to them.
 *
 * A time-based heartbeat cannot prove a remote owner is actually gone — a
 * slow EFS write, a GC pause, or CPU starvation can all make a live owner
 * look stale without it ever having stopped using the profile. The only
 * thing that proves that is the kernel's own advisory lock: `flock(2)`,
 * exposed here via a long-lived `flock(1)` child process holding an
 * exclusive, non-blocking lock on the file for as long as the session is
 * alive. NFSv4.1 (which EFS speaks) supports this correctly — unlike the
 * old NFSv3 `rpc.lockd`, which never did. If the owning process (or its
 * whole container) dies for any reason, including SIGKILL, the kernel
 * releases the flock immediately and unconditionally; the next acquire()
 * attempt then succeeds with no timer, no guess, and no window where two
 * processes can both believe they hold the same profile.
 *
 * The JSON written into the same file is diagnostic only (which owner/task,
 * since when) — it is never consulted to decide whether an acquire may
 * proceed. Only the flock's own grant/refusal from the kernel decides that.
 */

export const LOCK_FILE_NAME = '.wppconnect-profile.lock';

export interface ProfileLockInfo {
  ownerId: string;
  pid: number;
  acquiredAt: number;
  /** Diagnostic only, updated periodically while held — never read back to
   * authorize a reclaim. Only a failed flock() attempt does that. */
  heartbeatAt: number;
}

export type AcquireResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; reason: 'locked' | 'error'; heldBy?: ProfileLockInfo };

const processInstanceId = crypto.randomBytes(4).toString('hex');

export function getOwnerId(): string {
  const ecsTaskArn = process.env.ECS_TASK_ARN;
  if (ecsTaskArn) return ecsTaskArn;
  return `${os.hostname()}:${process.pid}:${processInstanceId}`;
}

export function lockFilePath(
  customUserDataDir: string,
  session: string
): string {
  return path.join(path.resolve(customUserDataDir, session), LOCK_FILE_NAME);
}

/** Parses a lock file's diagnostic contents. Anything that doesn't parse as
 * a well-formed ProfileLockInfo is treated as absent — this is display-only
 * information, never a basis for granting or refusing a lock. */
export function parseLockInfo(raw: string): ProfileLockInfo | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.ownerId === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.acquiredAt === 'number' &&
      typeof parsed.heartbeatAt === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Diagnostic only — a heartbeat older than `staleThresholdMs` is worth
 * surfacing to a human (health check, log line) as "this looks wrong,
 * maybe go look at it," but it must never be used to decide whether a new
 * acquire() may proceed. Only `flock(2)`'s own grant/refusal decides that.
 */
export function isLockStale(
  info: ProfileLockInfo | null,
  staleThresholdMs: number,
  now: number = Date.now()
): boolean {
  if (!info) return true;
  return now - info.heartbeatAt > staleThresholdMs;
}

async function readLockInfo(filePath: string): Promise<ProfileLockInfo | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return parseLockInfo(raw);
  } catch {
    return null;
  }
}

async function writeLockInfo(
  filePath: string,
  info: ProfileLockInfo
): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(info), 'utf8');
}

const FLOCK_BIN = process.env.PROFILE_LOCK_FLOCK_BIN || 'flock';
const ACQUIRE_SIGNAL = 'WPPCONNECT_LOCK_ACQUIRED';

/**
 * Runs after Node dies without ever calling release() (EOF on fd 3). Node's
 * own death does NOT prove Chromium is gone — Chromium is a *separate*
 * child Puppeteer spawned, not a child of this holder, and Linux does not
 * kill it just because its launcher died. Confirmed directly: killing only
 * Node left a still-running browser process behind, and a second
 * acquireProfileLock() call for the same profile wrongly succeeded while it
 * was still alive.
 *
 * So before actually exiting (which releases the flock), this polls
 * /proc for any process whose argv still contains
 * `--user-data-dir=<this profile dir>` — the same marker Chromium is
 * launched with — and refuses to let go while one exists. Past
 * `WPP_ORPHAN_KILL_AFTER_S` seconds of polling, Node is gone and cannot run
 * its own close()/treeKill fallback anymore, so this takes over that job
 * and force-kills whatever is still found, the same "graceful window, then
 * force" shape closeBrowser() already uses — just reimplemented in shell
 * since no Node process is left to do it.
 *
 * This is a best-effort, same-container check (another ECS task's
 * Chromium, in a different PID namespace, is invisible to /proc here and
 * does not need to be — that case is already excluded by the flock it
 * itself still holds).
 *
 * The same `guard` function also runs on SIGTERM, not just on EOF —
 * release() itself still kills the holder directly and fast (it only ever
 * calls release() once it already confirmed Chromium closed, so `guard`
 * resolves instantly there), but this way *any* external SIGTERM to the
 * holder — a generic process-cleanup tool, not this codebase's own
 * release() — goes through the same check instead of dying immediately.
 * A true SIGKILL aimed at this exact holder PID specifically (as opposed to
 * Node, or the whole container) cannot be intercepted by any process on any
 * Unix system — that is a kernel guarantee, not a gap in this design.
 */
const ORPHAN_GUARD_SH = `
guard() {
  tries=0
  max=\${WPP_ORPHAN_KILL_AFTER_S:-10}
  while [ "$tries" -lt "$max" ]; do
    found=""
    for p in /proc/[0-9]*/cmdline; do
      pid=$(basename "$(dirname "$p")" 2>/dev/null)
      [ "$pid" = "$$" ] && continue
      if [ -r "$p" ] && tr '\\0' '\\n' < "$p" 2>/dev/null | grep -qF -- "--user-data-dir=$WPP_PROFILE_DIR"; then
        found="$found $pid"
      fi
    done
    [ -z "$found" ] && exit 0
    tries=$((tries + 1))
    sleep 1
  done
  for pid in $found; do kill -9 "$pid" 2>/dev/null; done
  exit 0
}
echo ${ACQUIRE_SIGNAL}
trap guard TERM
read -r _ <&3
guard
`;

interface HeldLock {
  proc: ChildProcess;
  heartbeatTimer: NodeJS.Timeout;
  filePath: string;
}

/** Every lock this process currently believes it holds, keyed by session.
 * Used both for normal release() and to drain locks for sessions that never
 * made it as far as the SessionManager (still mid-initialize) when shutdown
 * arrives — see shutdownManager.ts. */
const activeLocks = new Map<string, HeldLock>();

/**
 * Spawns `flock(1)` against `filePath` in non-blocking exclusive mode. If
 * the lock is immediately available, `flock` execs a tiny shell that prints
 * `ACQUIRE_SIGNAL` (our deterministic "the kernel actually granted this"
 * signal — no timing guess) and then sleeps forever, holding the lock for
 * as long as that process lives. If the lock is busy, `flock -n` exits
 * immediately without ever running the shell, and no signal is printed.
 * `timeoutMs` only guards against `flock` itself being missing or hanging
 * unexpectedly — it is never what decides whether the lock was granted.
 */
function spawnFlockHolder(
  filePath: string,
  timeoutMs: number,
  orphanKillAfterS: number
): Promise<{ proc: ChildProcess; acquired: boolean }> {
  return new Promise((resolve) => {
    // --no-fork is load-bearing: without it, flock(1) forks a child to run
    // the command and the PID we get back is the *wrapper*, not the
    // lock-holding process — killing it alone leaves that forked child
    // (and the flock it inherited) running forever, orphaned. With
    // --no-fork, flock execs the shell in place, so this single PID is the
    // real holder end to end and a plain kill fully releases the lock.
    // ORPHAN_GUARD_SH uses `read` (a shell builtin) rather than `cat` for
    // the same reason — an external `cat` would itself fork a child that
    // survives a SIGTERM aimed at the shell, recreating the exact problem
    // --no-fork exists to avoid (confirmed directly: with `cat`, a
    // controlled release() left an orphaned `cat` behind).
    //
    // The script first waits on fd 3 (an extra pipe Node opens below)
    // until EOF — Node never writes to or closes its end itself, it just
    // holds it open for as long as it's alive. The OS closes every fd a
    // process held the instant that process dies, by ANY means, including
    // an uncatchable SIGKILL aimed at Node alone (not the whole container).
    // That ties this holder's wake-up to Node's own death without relying
    // on Node ever running cleanup code — `sleep infinity` could not do
    // this (confirmed by direct test: killing only Node left it orphaned
    // forever). After waking, ORPHAN_GUARD_SH refuses to actually let the
    // flock go until Chromium itself — a separate process Node does not
    // take down with it — is also confirmed gone (also confirmed directly:
    // without this, a second acquire wrongly succeeded while a stand-in
    // "Chromium" was still running).
    const proc = spawn(
      FLOCK_BIN,
      [
        '--nonblock',
        '--exclusive',
        '--no-fork',
        filePath,
        'sh',
        '-c',
        ORPHAN_GUARD_SH,
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore', 'pipe'],
        env: {
          ...process.env,
          WPP_PROFILE_DIR: path.dirname(filePath),
          WPP_ORPHAN_KILL_AFTER_S: String(orphanKillAfterS),
        },
      }
    );

    let settled = false;
    const finish = (acquired: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.removeAllListeners('data');
      resolve({ proc, acquired });
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();

    proc.once('error', () => finish(false));
    proc.once('exit', () => finish(false));
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes(ACQUIRE_SIGNAL)) finish(true);
    });
  });
}

/** Kills a flock-holding child, waiting (bounded) for it to actually exit —
 * only then is the kernel guaranteed to have released the flock. */
async function killFlockHolder(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(forceKill);
      clearTimeout(giveUp);
      resolve();
    };
    proc.once('exit', finish);
    proc.kill('SIGTERM');
    const forceKill = setTimeout(() => proc.kill('SIGKILL'), 2000);
    forceKill.unref?.();
    const giveUp = setTimeout(finish, 2500);
    giveUp.unref?.();
  });
}

export interface ProfileLockOptions {
  heartbeatIntervalMs: number;
  /** How long to wait for `flock(1)` to report in before treating the
   * attempt as failed. This is operational safety (the binary is missing,
   * the shell hung) — it never authorizes a reclaim; only a kernel refusal
   * or grant does. */
  acquireTimeoutMs?: number;
  /** How many seconds the holder polls /proc for a still-running Chromium
   * after Node dies unexpectedly before force-killing whatever it finds.
   * Only reached when Node is already gone and cannot run its own
   * close()/treeKill fallback anymore. */
  orphanKillAfterS?: number;
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
  /**
   * Called when the lock-holding process dies on its own — killed
   * externally, OOM, a bug in `flock`/`cat` — *without* `release()` ever
   * having been called. The caller no longer has any coordination over
   * this profile even though Chromium itself may still be running against
   * it; the only safe response is to treat the session as compromised
   * (isolate/close it, refuse to reuse it) rather than silently continuing
   * as if nothing happened.
   */
  onUnexpectedLoss?: () => void;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;
const DEFAULT_ORPHAN_KILL_AFTER_S = 10;

/**
 * Attempts to take ownership of a session's profile directory using a real
 * kernel advisory lock. Succeeds only when the kernel confirms no other
 * process (in this container or another ECS task over EFS) currently holds
 * it. Never reclaims based on elapsed time — if it cannot prove the previous
 * owner is gone, it refuses rather than guesses.
 */
export async function acquireProfileLock(
  session: string,
  customUserDataDir: string,
  options: ProfileLockOptions
): Promise<AcquireResult> {
  const dir = path.resolve(customUserDataDir, session);
  const filePath = path.join(dir, LOCK_FILE_NAME);
  const logger = options.logger ?? { info: () => {}, error: () => {} };

  try {
    await fs.promises.mkdir(dir, { recursive: true });

    const { proc, acquired } = await spawnFlockHolder(
      filePath,
      options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
      options.orphanKillAfterS ?? DEFAULT_ORPHAN_KILL_AFTER_S
    );

    if (!acquired) {
      // Diagnostic only — whatever is in the file (possibly stale, possibly
      // corrupt, possibly nothing) never changes the refusal above.
      const existing = await readLockInfo(filePath);
      logger.error(
        `[${session}] Profile is in use by a live process` +
          (existing ? ` (${existing.ownerId})` : '') +
          '; refusing to start a second Chromium against it'
      );
      return {
        acquired: false,
        reason: 'locked',
        heldBy: existing ?? undefined,
      };
    }

    const info: ProfileLockInfo = {
      ownerId: getOwnerId(),
      pid: proc.pid ?? -1,
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    // Best-effort — a failed diagnostic write never affects the real lock,
    // which is the live flock-holding process registered below.
    await writeLockInfo(filePath, info).catch(() => {});

    const heartbeatTimer = setInterval(() => {
      writeLockInfo(filePath, { ...info, heartbeatAt: Date.now() }).catch(
        () => {}
      );
    }, options.heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    activeLocks.set(session, { proc, heartbeatTimer, filePath });

    // If the holder dies on its own (OOM-killed, crashed, manually killed
    // outside of release()), stop claiming we still hold the lock — we no
    // longer do, the kernel already let it go. The map entry is already
    // gone by the time our *own* release() causes this exit (it deletes
    // before killing), so reaching this branch at all means the exit was
    // unexpected — nobody here asked for it.
    proc.once('exit', (code, signal) => {
      const current = activeLocks.get(session);
      if (current?.proc === proc) {
        clearInterval(current.heartbeatTimer);
        activeLocks.delete(session);
        logger.error(
          `[${session}] Profile lock holder exited unexpectedly ` +
            `(code=${code}, signal=${signal}) while still registered as held`
        );
        options.onUnexpectedLoss?.();
      }
    });

    logger.info(
      `[${session}] Acquired profile lock (flock) as ${info.ownerId}`
    );

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      const current = activeLocks.get(session);
      if (current?.proc === proc) activeLocks.delete(session);
      clearInterval(heartbeatTimer);
      await killFlockHolder(proc);
      await fs.promises.rm(filePath, { force: true }).catch(() => {});
    };

    return { acquired: true, release };
  } catch (error) {
    logger.error(
      `[${session}] Failed to acquire profile lock: ${(error as Error).message}`
    );
    return { acquired: false, reason: 'error' };
  }
}

/** Best-effort release for callers that never kept the `release` closure
 * from `acquireProfileLock` (e.g. the explicit logout/close HTTP routes).
 * A no-op if this process does not currently hold a lock for `session` —
 * it can only ever release a lock it itself is holding, never one taken
 * over by a different, newer attempt. */
export async function releaseProfileLockForSession(
  session: string
): Promise<void> {
  const held = activeLocks.get(session);
  if (!held) return;
  activeLocks.delete(session);
  clearInterval(held.heartbeatTimer);
  await killFlockHolder(held.proc);
  await fs.promises.rm(held.filePath, { force: true }).catch(() => {});
}

/**
 * Releases every profile lock this process currently holds, including ones
 * for sessions still mid-initialize that never reached the SessionManager —
 * used by the SIGTERM/shutdown path so an in-flight `create()` call does not
 * leave Chromium's profile claimed after the process exits.
 */
export async function releaseAllProfileLocks(): Promise<void> {
  const entries = Array.from(activeLocks.entries());
  await Promise.all(
    entries.map(async ([session, held]) => {
      activeLocks.delete(session);
      clearInterval(held.heartbeatTimer);
      await killFlockHolder(held.proc);
      await fs.promises.rm(held.filePath, { force: true }).catch(() => {});
    })
  );
}

/** Test-only: lets tests see/await currently held locks without reaching
 * into module-private state directly. */
export function __activeLockSessionsForTests(): string[] {
  return Array.from(activeLocks.keys());
}

/** Test-only: forces every heartbeat interval and flock holder to stop,
 * regardless of owner — cleans up between tests that intentionally leave
 * locks held (e.g. testing the "close() fails" path). */
export async function __stopAllLocksForTests(): Promise<void> {
  await releaseAllProfileLocks();
}
