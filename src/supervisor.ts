import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Restart the bot after an unexpected exit; explicit shutdown stops both processes. */
export function supervise(options: {
  spawnChild?: () => ChildProcess;
  restartDelayMs?: number;
  onExit?: (code: number) => void;
  log?: (message: string) => void;
} = {}): { stop: (signal?: NodeJS.Signals) => void } {
  const spawnChild = options.spawnChild ?? (() => spawn(process.execPath, ["--env-file=.env", "--import=tsx", "src/index.ts"], { stdio: "inherit" }));
  const onExit = options.onExit ?? ((code) => { process.exitCode = code; });
  const log = options.log ?? console.warn;
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let stopping = false;
  let failures = 0;
  const start = (): void => {
    if (stopping) return;
    const started = Date.now();
    let ended = false;
    const exited = (): void => {
      if (ended) return;
      ended = true;
      child = undefined;
      if (watchdog) clearTimeout(watchdog);
      if (stopping) { onExit(0); return; }
      if (Date.now() - started > 60_000) failures = 0;
      const delay = Math.min(60_000, (options.restartDelayMs ?? 1000) * 2 ** Math.min(failures++, 6));
      log(`GroupCart stopped unexpectedly. Restarting in ${delay / 1000} seconds.`);
      timer = setTimeout(start, delay);
    };
    try {
      child = spawnChild();
      child.once("error", exited);
      child.once("exit", exited);
    } catch { exited(); }
  };
  start();
  return {
    stop(signal = "SIGTERM") {
      if (stopping) return;
      stopping = true;
      if (timer) clearTimeout(timer);
      if (!child) { onExit(0); return; }
      child.kill(signal);
      watchdog = setTimeout(() => { child?.kill("SIGKILL"); }, 10_000);
      watchdog.unref();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const supervisor = supervise();
  process.once("SIGTERM", () => supervisor.stop("SIGTERM"));
  process.once("SIGINT", () => supervisor.stop("SIGINT"));
}
