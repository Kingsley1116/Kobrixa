import { managedPath, type DeviceSession } from "@kobrixa/device";
import type {
  LegacyProviderRequest,
  LegacyProviderValue,
  ProviderStep,
} from "../../device-broker/provider.js";
export async function executeLegacy(
  bind: (step: ProviderStep) => DeviceSession,
  request: LegacyProviderRequest,
  signal: AbortSignal,
): Promise<LegacyProviderValue> {
  const path = managedPath(request.remotePath, !["list", "download", "run"].includes(request.kind));
  switch (request.kind) {
    case "list":
      return { kind: "entries", entries: await bind("read").list(path, signal) };
    case "download": {
      let transferred = 0;
      await bind("read").download(
        path,
        async (bytes) => {
          await request.sink(bytes);
          transferred += bytes.length;
        },
        signal,
        request.progress,
      );
      return { kind: "transfer", transferred };
    }
    case "upload": {
      await bind("file-begin").uploadStream(
        path,
        request.size,
        request.chunks,
        signal,
        request.progress,
      );
      return { kind: "transfer", transferred: request.size };
    }
    case "mkdir": {
      const session = bind("file-mkdir");
      await session.createDirectory(path, signal);
      const parent = path.slice(0, path.lastIndexOf("/"));
      const verified = (await bind("read").list(parent, signal)).some(
        (e) => e.path === path && e.kind === "directory",
      );
      if (!verified) throw new Error("Directory creation was not verified.");
      return { kind: "mutation", verified };
    }
    case "rename":
      await bind("file-copy").rename(path, managedPath(request.destination, true), signal);
      return { kind: "mutation", verified: true };
    case "delete":
      await bind("file-remove").delete(path, signal);
      return { kind: "mutation", verified: true };
    case "run":
      await bind("program-run").run(path, signal);
      return { kind: "launch", sent: true };
  }
}
