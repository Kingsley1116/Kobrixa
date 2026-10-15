import {
  PLUGIN_API_VERSION,
  RPC_ERRORS,
  RpcError,
  RpcPeer,
  type Permission,
  type PluginLocale,
  type Severity,
} from "@kobrixa/plugin-protocol";
import { messageOf, PluginError, type PluginErrorCode, type PluginProblem } from "./errors.js";
import type { PluginProcess, ProcessExit } from "./process.js";

export interface LaunchablePlugin {
  readonly id: string;
  /** The manager's source key, so launchers can file output under the right source. */
  readonly sourceKey?: string;
  readonly directory: string;
  readonly entry: string;
  readonly runtime: "node" | "python";
  readonly permissions: readonly Permission[];
  readonly commands: readonly string[];
}
export type PluginLauncher = (plugin: LaunchablePlugin) => Promise<PluginProcess>;
export type SupervisorState = "idle" | "starting" | "running" | "stopping" | "failed";
/** Why a stop interrupts running commands: a disable, or a reload/removal that cancels them. */
export type StopReason = "disabled" | "cancelled";
export interface SupervisorOptions {
  locale: PluginLocale;
  onNotice(notice: { severity: Severity; message: string }): void;
  onStateChange?(): void;
  restartLimit?: number;
  restartWindowMs?: number;
  initializeTimeoutMs?: number;
  commandTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Upper bound on waiting for an exit after shutdown or kill; stop() never waits longer. */
  exitTimeoutMs?: number;
  cancelGraceMs?: number;
  now?(): number;
}
const DEFAULTS = {
  restartLimit: 3,
  restartWindowMs: 5 * 60_000,
  initializeTimeoutMs: 10_000,
  commandTimeoutMs: 30_000,
  stopTimeoutMs: 2_000,
  exitTimeoutMs: 4_000,
  cancelGraceMs: 5_000,
};
const major = (version: string) => version.split(".")[0];
const describeExit = (exit: ProcessExit) => exit.reason ?? `exit code ${exit.code ?? "unknown"}`;

export class PluginSupervisor {
  #state: SupervisorState = "idle";
  #problem: PluginProblem | undefined;
  #process: PluginProcess | undefined;
  #peer: RpcPeer | undefined;
  #starting: Promise<RpcPeer> | undefined;
  #launching: Promise<void> | undefined;
  #stoppingRun: Promise<void> | undefined;
  #stopping = false;
  #forced = false;
  #stopReason: StopReason = "disabled";
  /** Set while a launch is in flight; stop() calls it when the launch outlives the stop bound. */
  #abandonLaunch: (() => void) | undefined;
  #crashes: number[] = [];
  // Error continuations may run after stop() has already cleared #stopping.
  readonly #stoppedPeers = new WeakSet<RpcPeer>();
  readonly #options: SupervisorOptions & typeof DEFAULTS;

  constructor(
    readonly plugin: LaunchablePlugin,
    private readonly launcher: PluginLauncher,
    options: SupervisorOptions,
  ) {
    this.#options = { ...DEFAULTS, ...options };
  }

  get state(): SupervisorState {
    return this.#state;
  }
  get problem(): PluginProblem | undefined {
    return this.#problem;
  }

  async executeCommand(command: string, signal?: AbortSignal): Promise<void> {
    if (!this.plugin.commands.includes(command))
      throw new PluginError(
        "PLUGIN_E_UNKNOWN_COMMAND",
        `${this.plugin.id} does not contribute ${command}.`,
      );
    const peer = await this.#ensureStarted();
    try {
      await peer.request(
        "command/execute",
        { command },
        { timeoutMs: this.#options.commandTimeoutMs, ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      throw this.#translate(error, peer);
    }
  }

  /**
   * Graceful stop with a fixed timeline measured from the call: shutdown/exit, then kill() at
   * stopTimeoutMs (kill escalates to SIGKILL by itself), and give up waiting for the exit report
   * at stopTimeoutMs + exitTimeoutMs. A pending handshake is not awaited: only the launch is.
   */
  stop(reason: StopReason = "disabled"): Promise<void> {
    // Concurrent callers (disable, then app shutdown) share one stop: one shutdown request only.
    if (!this.#stoppingRun) this.#stopReason = reason;
    this.#stoppingRun ??= this.#stop().finally(() => {
      this.#stoppingRun = undefined;
    });
    return this.#stoppingRun;
  }

  async #stop(): Promise<void> {
    const deadline = (this.#options.now ?? Date.now)() + this.#stopBoundMs;
    this.#stopping = true;
    try {
      if (!this.#process && this.#launching) {
        if (!(await this.#within(this.#launching, deadline - (this.#options.now ?? Date.now)()))) {
          // The launcher never settled: stop waiting, and kill its process if it appears later.
          this.#abandonLaunch?.();
          await this.#starting?.catch(() => undefined);
          return;
        }
      }
      const peer = this.#peer;
      const child = this.#process;
      if (!peer || !child) return;
      // A plugin still in its handshake has not activated: nothing to shut down, just terminate.
      const handshaking = this.#state === "starting";
      this.#setState("stopping");
      const exited = new Promise<boolean>((resolve) => child.onExit(() => resolve(true)));
      if (handshaking) child.kill();
      // Covers a plugin that acknowledges shutdown but ignores "exit".
      const lingering = setTimeout(() => child.kill(), this.#options.stopTimeoutMs);
      if (!handshaking)
        void peer
          .request("shutdown", {}, { timeoutMs: this.#options.stopTimeoutMs })
          .then(() => peer.notify("exit", {}))
          .catch(() => child.kill());
      const exitedInTime = await this.#within(
        exited,
        Math.max(0, deadline - (this.#options.now ?? Date.now)()),
      );
      clearTimeout(lingering);
      if (!exitedInTime)
        this.#exited(child, peer, { code: null, reason: "did not exit after a forced kill" });
    } finally {
      this.#stopping = false;
    }
  }

  get #stopBoundMs(): number {
    return this.#options.stopTimeoutMs + this.#options.exitTimeoutMs;
  }

  /** True when `work` settles within `ms`; never leaves its timer behind. */
  async #within(work: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #stopError(message: string): PluginError {
    return new PluginError(
      this.#stopReason === "cancelled" ? "PLUGIN_E_CANCELLED" : "PLUGIN_E_DISABLED",
      message,
    );
  }

  /** Terminates immediately, e.g. when the manager's overall shutdown deadline is reached. */
  forceKill(): void {
    this.#forced = true;
    this.#process?.forceKill();
  }

  #ensureStarted(): Promise<RpcPeer> {
    if (this.#stopping) return Promise.reject(this.#stopError(`${this.plugin.id} is stopping.`));
    if (this.#state === "failed")
      return Promise.reject(
        new PluginError(
          "PLUGIN_E_CRASH_LOOP",
          this.#problem?.message ?? `${this.plugin.id} stopped after repeated failures.`,
        ),
      );
    if (this.#state === "running" && this.#peer) return Promise.resolve(this.#peer);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #start(): Promise<RpcPeer> {
    // Later reads use the `problem` getter: TypeScript keeps `this.#problem` narrowed to
    // undefined after this assignment even though callbacks change it across awaits.
    this.#problem = undefined;
    this.#setState("starting");
    const launching = this.launcher(this.plugin);
    const abandoned = new Promise<"abandoned">((resolve) => {
      this.#abandonLaunch = () => resolve("abandoned");
    });
    this.#launching = launching.then(
      () => undefined,
      () => undefined,
    );
    let launched: PluginProcess | "abandoned";
    try {
      launched = await Promise.race([launching, abandoned]);
    } catch (error) {
      this.#problem = { code: "PLUGIN_E_LAUNCH", message: messageOf(error) };
      this.#setState("idle");
      throw new PluginError("PLUGIN_E_LAUNCH", this.#problem.message);
    } finally {
      this.#launching = undefined;
      this.#abandonLaunch = undefined;
    }
    if (launched === "abandoned") {
      void launching.then(
        (late) => late.forceKill(),
        () => undefined,
      );
      this.#setState("idle");
      throw this.#stopError(`${this.plugin.id} was stopped before it finished launching.`);
    }
    const child = launched;
    const peer = new RpcPeer(child, {
      timeoutMs: this.#options.commandTimeoutMs,
      cancelGraceMs: this.#options.cancelGraceMs,
      onProtocolError: (error) =>
        this.#terminate(child, { code: "PLUGIN_E_PROTOCOL", message: error.message }),
      onUnresponsive: (method) =>
        this.#terminate(child, {
          code: "PLUGIN_E_UNRESPONSIVE",
          message: `${method} did not finish within ${this.#options.cancelGraceMs} ms after cancellation.`,
        }),
    });
    // Identity comes from this channel, never from message contents.
    peer.handle("ui/showMessage", (params) => {
      if (!this.plugin.permissions.includes("ui.notifications"))
        throw new RpcError(
          RPC_ERRORS.permissionDenied,
          "The plugin manifest does not request ui.notifications.",
        );
      this.#options.onNotice({ severity: params.severity, message: params.message });
      return null;
    });
    this.#process = child;
    this.#peer = peer;
    child.onExit((exit) => this.#exited(child, peer, exit));
    // stop() started during the launch: it terminates this process; skip the handshake.
    if (this.#stopping) {
      if (this.#forced) child.forceKill();
      throw this.#stopError(`${this.plugin.id} is stopping.`);
    }
    try {
      const result = await peer.request(
        "initialize",
        {
          apiVersion: PLUGIN_API_VERSION,
          pluginId: this.plugin.id,
          locale: this.#options.locale,
          grantedPermissions: [...this.plugin.permissions],
        },
        { timeoutMs: this.#options.initializeTimeoutMs },
      );
      if (major(result.apiVersion) !== major(PLUGIN_API_VERSION))
        throw new PluginError(
          "PLUGIN_E_HANDSHAKE",
          `The plugin SDK implements API ${result.apiVersion}; Kobrixa requires ${PLUGIN_API_VERSION}.`,
        );
    } catch (error) {
      if (!this.#stopping && !this.#stoppedPeers.has(peer)) {
        // Keep #starting shared until the child's exit is reported; kill() escalates if needed.
        // Otherwise a retry could replace #process while the failed child is still alive.
        const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
        this.#terminate(child, { code: "PLUGIN_E_HANDSHAKE", message: messageOf(error) });
        if (!(await this.#within(exited, this.#stopBoundMs)))
          this.#exited(child, peer, { code: null, reason: "did not exit after a forced kill" });
      }
      if (this.#stopping || this.#stoppedPeers.has(peer))
        throw this.#stopError(`${this.plugin.id} was stopped.`);
      throw new PluginError(
        this.problem?.code ?? "PLUGIN_E_HANDSHAKE",
        this.problem?.message ?? messageOf(error),
      );
    }
    if (this.#stopping || this.#stoppedPeers.has(peer))
      throw this.#stopError(`${this.plugin.id} is stopping.`);
    if (this.#peer !== peer)
      throw new PluginError(
        this.problem?.code ?? "PLUGIN_E_CRASHED",
        this.problem?.message ?? `${this.plugin.id} exited during startup.`,
      );
    this.#setState("running");
    return peer;
  }

  #terminate(child: PluginProcess, problem: PluginProblem): void {
    if (this.#process !== child) return;
    this.#problem ??= problem;
    child.kill();
  }

  #exited(child: PluginProcess, peer: RpcPeer, exit: ProcessExit): void {
    if (this.#process !== child) return;
    this.#process = undefined;
    this.#peer = undefined;
    if (this.#stopping) {
      this.#stoppedPeers.add(peer);
      peer.close(new RpcError(RPC_ERRORS.connectionClosed, `${this.plugin.id} was stopped.`));
      this.#setState("idle");
      return;
    }
    const tail = child.stderrTail().trim().split("\n").slice(-3).join("\n");
    this.#problem ??= {
      code: "PLUGIN_E_CRASHED",
      message: `${this.plugin.id} exited unexpectedly (${describeExit(exit)}).${tail ? `\n${tail}` : ""}`,
    };
    const now = (this.#options.now ?? Date.now)();
    this.#crashes = [
      ...this.#crashes.filter((at) => now - at < this.#options.restartWindowMs),
      now,
    ];
    const failed = this.#crashes.length >= this.#options.restartLimit;
    if (failed)
      this.#problem = {
        code: "PLUGIN_E_CRASH_LOOP",
        message: `${this.plugin.id} failed ${this.#crashes.length} times and stays stopped until it is disabled and enabled again. Last problem: ${this.#problem.message}`,
      };
    // Pending requests are rejected, never retried: side effects must not be replayed.
    peer.close(new RpcError(RPC_ERRORS.connectionClosed, this.#problem.message));
    this.#setState(failed ? "failed" : "idle");
  }

  #translate(error: unknown, peer: RpcPeer): PluginError {
    if (error instanceof PluginError) return error;
    if (!(error instanceof RpcError))
      return new PluginError("PLUGIN_E_COMMAND_FAILED", messageOf(error));
    const code: PluginErrorCode =
      error.code === RPC_ERRORS.connectionClosed
        ? this.#stopping || this.#stoppedPeers.has(peer)
          ? this.#stopError(error.message).code
          : (this.#problem?.code ?? "PLUGIN_E_CRASHED")
        : error.code === RPC_ERRORS.timeout
          ? "PLUGIN_E_TIMEOUT"
          : error.code === RPC_ERRORS.requestCancelled
            ? "PLUGIN_E_CANCELLED"
            : "PLUGIN_E_COMMAND_FAILED";
    return new PluginError(code, error.message);
  }

  #setState(state: SupervisorState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.();
  }
}
