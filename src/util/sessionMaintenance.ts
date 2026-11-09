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

// The runtime registry and this admission gate belong to the same server process.
let maintenanceActive = false;
let shuttingDown = false;
const starting = new Set<Promise<void>>();

export function isSessionMaintenanceActive(): boolean {
  return maintenanceActive;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Marks the process as shutting down, so no further session starts are
 * admitted while in-flight sessions are drained (see shutdownManager). There
 * is no undo — a process only shuts down once. */
export function beginShutdown(): void {
  shuttingDown = true;
}

/** Admit a start synchronously, before any token or browser work can begin. */
export function tryBeginSessionStart(): (() => void) | undefined {
  if (maintenanceActive || shuttingDown) return;
  let done!: () => void;
  const pending = new Promise<void>((resolve) => (done = resolve));
  starting.add(pending);
  return () => {
    starting.delete(pending);
    done();
  };
}

/** Exclude new starts immediately, then drain starts admitted before this call. */
export async function acquireSessionMaintenance(): Promise<() => void> {
  if (maintenanceActive) {
    throw new Error('Session backup or restore is already in progress');
  }
  maintenanceActive = true;
  await Promise.all(starting);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      maintenanceActive = false;
    }
  };
}
