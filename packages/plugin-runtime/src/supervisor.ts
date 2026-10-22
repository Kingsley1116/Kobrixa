import {
  ChannelActivation,
  registerActivationDeadline,
  remainingActivationMs,
} from "./ui-lifecycle.js";
import type { CommandInvocation, CommandValue, Result } from "@kobrixa/plugin-protocol";
import type { Handle, ResourceOwner } from "@kobrixa/plugin-protocol";
import type {
  OwnerRetirement,
  Stage3ChannelContext,
  Stage3ChannelBinding,
} from "./ui-lifecycle.js";
import {
  PLUGIN_API_VERSION,
  resourceOwnerSchema,
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
  readonly channelOwner?: ResourceOwner;
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
export type StopReason = "disabled" | "cancelled" | "removed" | "shutdown";
export interface SupervisorOptions {
  resourceOwner?: () => ResourceOwner;
  hostEpoch?: Handle;
  bindChannel?: (context: Stage3ChannelContext) => Stage3ChannelBinding;
  retireResources?: (owner: ResourceOwner, reason: OwnerRetirement) => Promise<void>;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A process may exit before anyone requests the initialized barrier.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

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
  #resourceOwner: ResourceOwner | undefined;
  #channelBinding: Stage3ChannelBinding | undefined;
  #channelContext: Stage3ChannelContext | undefined;
  #activation: AbortController | undefined;
  #channelActivation: ChannelActivation | undefined;
  #deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #removeDeadline: (() => void) | undefined;
  get activationTimers(): number {
    return this.#deadlineTimer === undefined ? 0 : 1;
  }
  #clearDeadline(): void {
    clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
    this.#removeDeadline?.();
    this.#removeDeadline = undefined;
  }
  #activationSignal: AbortSignal | undefined;
  #initializedPublished = false;
  #initialized = deferred<Stage3ChannelContext>();
  #resourceRetirement: Promise<void> | undefined;
  #terminatingChannel = false;

  #retireResources(reason: OwnerRetirement): Promise<void> {
    const owner = this.#resourceOwner;
    if (!owner) return Promise.resolve();
    if (this.#resourceRetirement) return this.#resourceRetirement;
    const receipt = deferred<void>();
    this.#resourceRetirement = receipt.promise;
    try {
      const retired = this.#options.retireResources!(owner, reason);
      void retired.then(receipt.resolve, receipt.reject);
    } catch (error) {
      receipt.reject(error);
    }
    return receipt.promise;
  }

  async settleResources(reason: OwnerRetirement): Promise<void> {
    if (this.#resourceOwner && this.#state === "starting") this.#activation?.abort();
    await this.#retireResources(reason);
  }
  // Error continuations may run after stop() has already cleared #stopping.
  readonly #stoppedPeers = new WeakSet<RpcPeer>();
  readonly #options: SupervisorOptions & typeof DEFAULTS;

  constructor(
    readonly plugin: LaunchablePlugin,
    private readonly launcher: PluginLauncher,
    options: SupervisorOptions,
  ) {
    const configured = [
      options.resourceOwner,
      options.hostEpoch,
      options.bindChannel,
      options.retireResources,
    ];
    if (
      configured.some((value) => value !== undefined) &&
      configured.some((value) => value === undefined)
    )
      throw new Error("Stage 3 supervisor options must be supplied together");
    this.#options = { ...DEFAULTS, ...options };
  }

  get state(): SupervisorState {
    return this.#state;
  }
  get problem(): PluginProblem | undefined {
    return this.#problem;
  }

  async activateInitialized(signal: AbortSignal): Promise<Stage3ChannelContext> {
    signal.throwIfAborted();
    const started = this.#ensureStarted();
    const barrier = this.#initialized;
    void started.catch((error) => barrier.reject(error));
    const context = await withSignal(barrier.promise, signal);
    signal.throwIfAborted();
    if (this.#peer !== context.peer || this.#stopping)
      throw this.#stopError("Retired initialized channel");
    return context;
  }
  async ready(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#resourceOwner && !this.#initializedPublished)
      throw new Error("Channel has not initialized.");
    await withSignal(this.#ensureStarted(), signal);
    signal.throwIfAborted();
  }

  async invoke(invocation: CommandInvocation, signal?: AbortSignal): Promise<Result<CommandValue>> {
    if (!this.plugin.commands.includes(invocation.command))
      throw new PluginError(
        "PLUGIN_E_UNKNOWN_COMMAND",
        "The source does not contribute this command.",
      );
    const peer = await this.#ensureStarted();
    try {
      return await peer.request("command/invoke", invocation, {
        timeoutMs: this.#options.commandTimeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw this.#translate(error, peer);
    }
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
   * at exitTimeoutMs. A pending handshake is not awaited: only the launch is.
   */
  stop(reason: StopReason = "disabled"): Promise<void> {
    // Concurrent callers (disable, then app shutdown) share one stop: one shutdown request only.
    if (!this.#stoppingRun) this.#stopReason = reason;
    this.#stopping = true;
    if (this.#resourceOwner && this.#state === "starting") this.#activation?.abort();
    const retirement =
      reason === "cancelled"
        ? "reload"
        : reason === "disabled"
          ? "disable"
          : reason === "removed"
            ? "remove"
            : reason;
    const stop = () =>
      this.#resourceOwner
        ? this.#retireResources(retirement).then(
            () => this.#stop(),
            async (error: unknown) => {
              await this.#stop();
              throw error;
            },
          )
        : this.#stop();
    this.#stoppingRun ??= stop().finally(() => {
      this.#stoppingRun = undefined;
    });
    return this.#stoppingRun;
  }

  get #stopBoundMs(): number {
    return this.#options.exitTimeoutMs;
  }
  async #stop(): Promise<void> {
    const now = this.#options.now ?? Date.now;
    const deadline = now() + this.#stopBoundMs;
    this.#stopping = true;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let removeExit: (() => void) | undefined;
    try {
      if (
        !this.#process &&
        this.#launching &&
        !(await this.#within(this.#launching, Math.max(0, deadline - now())))
      ) {
        this.#abandonLaunch?.();
        throw new PluginError("PLUGIN_E_TIMEOUT", "Plugin launch has not reported a disposition.");
      }
      const child = this.#process;
      const peer = this.#peer;
      if (!child || !peer) return;
      const handshaking = this.#state === "starting";
      this.#setState("stopping");
      const exited = new Promise<void>((resolve) => {
        removeExit = child.onExit(() => resolve());
      });
      const remaining = Math.max(0, deadline - now());
      killTimer = setTimeout(() => child.kill(), Math.min(this.#options.stopTimeoutMs, remaining));
      if (handshaking) child.kill();
      else
        void peer
          .request(
            "shutdown",
            {},
            {
              timeoutMs: Math.min(this.#options.stopTimeoutMs, remaining),
            },
          )
          .then(() => peer.notify("exit", {}))
          .catch(() => child.kill());
      if (!(await this.#within(exited, remaining))) {
        child.forceKill();
        this.#stoppedPeers.add(peer);
        this.#problem = { code: "PLUGIN_E_TIMEOUT", message: "Plugin exit is not confirmed." };
        peer.close(new RpcError(RPC_ERRORS.connectionClosed, this.#problem.message));
        throw new PluginError(this.#problem.code, this.#problem.message);
      }
    } finally {
      clearTimeout(killTimer);
      removeExit?.();
      // A child without an exit report remains stopping and cannot be replaced.
      this.#stopping = this.#process !== undefined;
      this.#forced = false;
    }
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
      this.#stopReason === "cancelled" || this.#stopReason === "removed"
        ? "PLUGIN_E_CANCELLED"
        : "PLUGIN_E_DISABLED",
      message,
    );
  }

  /** Terminates immediately, e.g. when the manager's overall shutdown deadline is reached. */
  forceKill(): void {
    if (this.#stopping) this.#forced = true;
    const child = this.#process;
    if (!this.#resourceOwner) {
      child?.forceKill();
      return;
    }
    void this.#retireResources("shutdown")
      .catch(() => undefined)
      .then(() => child?.forceKill());
  }

  #ensureStarted(): Promise<RpcPeer> {
    if (this.#terminatingChannel)
      return Promise.reject(
        new PluginError("PLUGIN_E_DISABLED", "Previous process resources are retiring."),
      );
    if (this.#stopping || (this.#process && !this.#peer))
      return Promise.reject(this.#stopError(`${this.plugin.id} is stopping.`));
    if (this.#state === "failed")
      return Promise.reject(
        new PluginError(
          "PLUGIN_E_CRASH_LOOP",
          this.#problem?.message ?? `${this.plugin.id} stopped after repeated failures.`,
        ),
      );
    if (this.#state === "running" && this.#peer) return Promise.resolve(this.#peer);
    this.#starting ??= this.#start()
      .catch(async (error: unknown) => {
        this.#activation?.abort();
        this.#initialized.reject(error);
        if (this.#resourceOwner) {
          // Includes launcher/bind failures and either activation barrier. Never release
          // the shared start promise while the original process can still be alive.
          await this.#retireResources("crashed").catch(() => undefined);
          const child = this.#process;
          const peer = this.#peer;
          if (child && peer && !this.#stopping) {
            const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
            child.kill();
            if (!(await this.#within(exited, this.#stopBoundMs))) {
              this.#stopping = true;
              this.#setState("stopping");
              child.forceKill();
              peer.close();
              throw new PluginError(
                "PLUGIN_E_TIMEOUT",
                "The failed startup process has not reported exit.",
              );
            }
          } else if (!child && this.#state === "starting") this.#setState("idle");
        }
        throw error;
      })
      .finally(() => {
        this.#clearDeadline();
        this.#starting = undefined;
      });
    return this.#starting;
  }

  async #start(): Promise<RpcPeer> {
    // Later reads use the `problem` getter: TypeScript keeps `this.#problem` narrowed to
    // undefined after this assignment even though callbacks change it across awaits.
    this.#problem = undefined;
    this.#setState("starting");
    this.#resourceOwner = this.#options.resourceOwner?.();
    this.#resourceRetirement = undefined;
    if (this.#resourceOwner) {
      resourceOwnerSchema.parse(this.#resourceOwner);
      Object.freeze(this.#resourceOwner);
    }
    if (this.#resourceOwner && this.#resourceOwner.hostEpoch !== this.#options.hostEpoch)
      throw new Error("Primary profile epoch mismatch");
    this.#activation = new AbortController();
    this.#initializedPublished = false;
    this.#initialized = deferred<Stage3ChannelContext>();
    void this.#initialized.promise.catch(() => undefined);
    this.#activationSignal = this.#activation.signal;
    const launching = Promise.resolve().then(() =>
      this.launcher({
        ...this.plugin,
        ...(this.#resourceOwner ? { channelOwner: this.#resourceOwner } : {}),
      }),
    );
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
      if (this.#stopping) throw this.#stopError(`${this.plugin.id} is stopping.`);
      const failed = this.#recordFailure();
      this.#setState(failed ? "failed" : "idle");
      throw new PluginError(this.#problem.code, this.#problem.message);
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
    // A stop during launch has already fenced this owner: do not bind it again.
    if (this.#stopping) {
      if (this.#forced) child.forceKill();
      throw this.#stopError(`${this.plugin.id} is stopping.`);
    }
    const now = this.#options.now ?? (() => performance.now());
    this.#removeDeadline = registerActivationDeadline(
      this.#activationSignal!,
      now() + this.#options.initializeTimeoutMs,
      now,
    );
    this.#deadlineTimer = setTimeout(() => {
      this.#deadlineTimer = undefined;
      this.#activation?.abort(new RpcError(RPC_ERRORS.timeout, "Activation deadline expired."));
    }, this.#options.initializeTimeoutMs);
    if (this.#resourceOwner) {
      const owner = this.#resourceOwner;
      // The manager wrapper replaces these unbound values with admitted registry data
      // before any host router sees the context. No caller message supplies identity.
      this.#channelContext = {
        peer,
        owner,
        principal: () => ({ kind: "plugin", owner, authorityContext: null }),
        requirements: Object.freeze([]),
      };
      this.#channelBinding = this.#options.bindChannel!(this.#channelContext);
      this.#channelActivation = new ChannelActivation(
        this.#channelContext,
        this.#channelBinding,
        this.#activationSignal!,
        () => this.#peer === peer && !this.#stopping,
      );
      void this.#channelActivation.initialized.then((context) => {
        this.#initializedPublished = true;
        this.#initialized.resolve(context);
      }, this.#initialized.reject);
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
        {
          timeoutMs: remainingActivationMs(this.#activationSignal!),
          signal: this.#activationSignal,
        },
      );
      if (major(result.apiVersion) !== major(PLUGIN_API_VERSION))
        throw new PluginError(
          "PLUGIN_E_HANDSHAKE",
          `The plugin SDK implements API ${result.apiVersion}; Kobrixa requires ${PLUGIN_API_VERSION}.`,
        );
      await this.#channelActivation?.afterInitialize();
    } catch (error) {
      if (!this.#stopping && !this.#stoppedPeers.has(peer)) {
        // Keep #starting shared until the child's exit is reported; kill() escalates if needed.
        // Otherwise a retry could replace #process while the failed child is still alive.
        const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
        this.#terminate(child, { code: "PLUGIN_E_HANDSHAKE", message: messageOf(error) });
        await this.#retireResources("crashed").catch(() => undefined);
        if (!(await this.#within(exited, this.#stopBoundMs))) {
          this.#stopping = true;
          this.#problem = {
            code: "PLUGIN_E_TIMEOUT",
            message: "The failed startup process has not reported exit.",
          };
          this.#setState("stopping");
          child.forceKill();
          peer.close();
          throw new PluginError(this.#problem.code, this.#problem.message);
        }
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
    if (!this.#resourceOwner) {
      child.kill();
      return;
    }
    this.#terminatingChannel = true;
    void this.#retireResources("crashed")
      .catch(() => undefined)
      .then(() => child.kill());
  }

  #exited(child: PluginProcess, peer: RpcPeer, exit: ProcessExit): void {
    if (this.#process !== child) return;
    // An OS-reported exit cannot be delayed. Revoke synchronously before clearing identity.
    if (this.#resourceOwner) {
      this.#terminatingChannel = true;
      void this.#retireResources("crashed")
        .catch(() => undefined)
        .finally(() => {
          this.#terminatingChannel = false;
        });
    }
    this.#activation?.abort();
    this.#initialized.reject(new Error("Channel retired during initialize"));
    this.#channelActivation?.dispose();
    this.#channelActivation = undefined;
    this.#channelBinding = undefined;
    this.#channelContext = undefined;
    this.#process = undefined;
    this.#peer = undefined;
    if (this.#stopping) {
      this.#stoppedPeers.add(peer);
      this.#stopping = false;
      peer.close(new RpcError(RPC_ERRORS.connectionClosed, `${this.plugin.id} was stopped.`));
      this.#setState("idle");
      return;
    }
    const tail = child.stderrTail().trim().split("\n").slice(-3).join("\n");
    this.#problem ??= {
      code: "PLUGIN_E_CRASHED",
      message: `${this.plugin.id} exited unexpectedly (${describeExit(exit)}).${tail ? `\n${tail}` : ""}`,
    };
    const failed = this.#recordFailure();
    // Pending requests are rejected, never retried: side effects must not be replayed.
    peer.close(new RpcError(RPC_ERRORS.connectionClosed, this.#problem.message));
    this.#setState(failed ? "failed" : "idle");
  }

  #recordFailure(): boolean {
    const now = (this.#options.now ?? Date.now)();
    this.#crashes = [
      ...this.#crashes.filter((at) => now - at < this.#options.restartWindowMs),
      now,
    ];
    const failed = this.#crashes.length >= this.#options.restartLimit;
    if (failed)
      this.#problem = {
        code: "PLUGIN_E_CRASH_LOOP",
        message: `${this.plugin.id} failed ${this.#crashes.length} times and stays stopped until an explicit reset. Last problem: ${this.#problem?.message ?? "Process failed."}`,
      };
    return failed;
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
