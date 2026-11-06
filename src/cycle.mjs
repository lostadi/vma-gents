function message(error) {
  return error instanceof Error ? error.message : String(error);
}

export class LifecycleCycleError extends Error {
  constructor(phase, error, evidence) {
    super(`VM lifecycle cycle failed during ${phase}: ${message(error)}`);
    this.name = "LifecycleCycleError";
    this.cause = error;
    this.evidence = evidence;
  }
}

export function assertCycleStartable(snapshot) {
  if (snapshot?.lifecycle?.running || snapshot?.controllerLease?.held) {
    throw new Error("VM cycle requires a stopped, unlocked clone and will not adopt an existing run");
  }
}

function abortableDelay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(cleanupAndResolve, milliseconds);
    const onAbort = () => cleanupAndReject(signal.reason ?? new Error("operation aborted"));
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function cleanupAndResolve() { cleanup(); resolve(); }
    function cleanupAndReject(error) { cleanup(); reject(error); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runLifecycleCycle({
  signal,
  start,
  status,
  readConsole,
  stop,
  verifyStopped = () => undefined,
  settleMilliseconds = 250,
}) {
  const evidence = { completed: false };
  let phase = "start";
  let primaryError = null;

  try {
    signal?.throwIfAborted();
    evidence.start = await start(signal);
    signal?.throwIfAborted();

    phase = "running-status";
    evidence.running = await status();
    signal?.throwIfAborted();

    phase = "settle";
    await abortableDelay(settleMilliseconds, signal);

    phase = "console";
    evidence.console = await readConsole();
    signal?.throwIfAborted();
  } catch (error) {
    primaryError = { phase, error };
  }

  phase = "stop";
  try {
    evidence.stop = await stop("mcp-cycle-finally");
  } catch (error) {
    evidence.cleanupError = message(error);
    throw new LifecycleCycleError(
      primaryError ? `${primaryError.phase} and cleanup` : phase,
      primaryError?.error ?? error,
      evidence,
    );
  }

  phase = "final-status";
  try {
    evidence.after = await status();
    await verifyStopped(evidence.after, evidence.stop);
  } catch (error) {
    throw new LifecycleCycleError(phase, error, evidence);
  }

  if (primaryError) {
    throw new LifecycleCycleError(primaryError.phase, primaryError.error, evidence);
  }

  evidence.completed = true;
  return evidence;
}
