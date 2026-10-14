import { createMemoryChannelPair, RpcPeer } from "@kobrixa/plugin-protocol";
import { ExitSignal, type PluginProcess } from "./process.js";

/** An in-memory plugin process whose plugin side is a raw RpcPeer, for supervisor tests. */
export function memoryPlugin(
  setup: (peer: RpcPeer, control: { exit(code?: number): void }) => void,
) {
  const [host, plugin] = createMemoryChannelPair();
  const exits = new ExitSignal();
  let killed = false;
  const peer = new RpcPeer(plugin);
  const exit = (code = 0) => {
    peer.close();
    queueMicrotask(() => exits.emit({ code }));
  };
  const terminate = (reason: string) => {
    killed = true;
    peer.close();
    queueMicrotask(() => exits.emit({ code: null, reason }));
  };
  setup(peer, { exit });
  const process: PluginProcess = {
    ...host,
    onExit: (listener) => exits.subscribe(listener),
    kill: () => terminate("killed"),
    forceKill: () => terminate("force-killed"),
    stderrTail: () => "",
  };
  return { process, killed: () => killed };
}
