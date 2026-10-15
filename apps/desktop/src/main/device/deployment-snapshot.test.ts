import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDeploymentSnapshot, type CompileResult, type BuildArtifact } from "@kobrixa/compiler";
import { UsbTransport, type RemoteEntry } from "@kobrixa/device";
import { DeviceService } from "./device.js";
import type { BuildService } from "../workspace/build.js";
vi.mock("electron", () => ({ dialog: {} }));
let root: string;
const services: DeviceService[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-deploy-"));
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.reset()));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const artifact = async (
    name: string,
    role: "deploy-main" | "deploy-asset",
    byte: number,
  ): Promise<BuildArtifact> => {
    const bytes = new Uint8Array([byte]);
    const file = path.join(root, name);
    await writeFile(file, bytes);
    return {
      slot: role === "deploy-main" ? "program" : "asset",
      kind: "not-rbf",
      role,
      mediaType: "application/octet-stream",
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: 1,
      ...(role === "deploy-asset" ? { remotePath: name } : {}),
    };
  };
  const result: CompileResult = {
    buildId: "build",
    target: "toy-vm",
    deploy: "ev3",
    runtimeDirectory: "/robot",
    success: true,
    diagnostics: [],
    artifacts: [
      await artifact("b.bin", "deploy-asset", 2),
      await artifact("main.bin", "deploy-main", 3),
      await artifact("a.bin", "deploy-asset", 1),
    ],
  };
  const session = {
    descriptor: { id: "mock", name: "EV3", transport: "usb" as const },
    connected: true,
    list: vi.fn(async (): Promise<RemoteEntry[]> => []),
    upload: vi.fn(async (_path: string, _bytes: Uint8Array) => {}),
    run: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(async () => {}),
    onDisconnect: () => () => {},
  };
  vi.spyOn(UsbTransport.prototype, "connect").mockResolvedValue(session as never);
  const builds = {
    deployableArtifacts: (_id: string, signal?: AbortSignal) =>
      readDeploymentSnapshot(result, "ev3", signal),
  } as unknown as BuildService;
  const service = new DeviceService(builds, () => undefined);
  services.push(service);
  const id = await service.connect(session.descriptor);
  return { result, service, session, id };
}
it("rejects a changed or missing last file before any upload", async () => {
  for (const missing of [false, true]) {
    const h = await fixture();
    const main = h.result.artifacts.find((item) => item.role === "deploy-main")!;
    if (missing) await rm(main.path);
    else await writeFile(main.path, new Uint8Array([9]));
    await expect(h.service.deploy(h.id, "build", "/robot")).rejects.toThrow("BUILD1006");
    expect(h.session.upload).not.toHaveBeenCalled();
    expect(h.session.list).not.toHaveBeenCalled();
    expect(h.service.busy).toBe(false);
  }
});
it("uploads the verified snapshot even if disk changes during transfer", async () => {
  const h = await fixture();
  h.session.upload.mockImplementationOnce(async () => {
    await writeFile(path.join(root, "main.bin"), new Uint8Array([99]));
  });
  await h.service.deploy(h.id, "build", h.result.runtimeDirectory!);
  expect(h.session.upload.mock.calls.map(([name, bytes]) => [name, [...bytes]])).toEqual([
    ["/robot/a.bin", [1]],
    ["/robot/b.bin", [2]],
    ["/robot/main.bin", [3]],
  ]);
});
it("rejects unsupported deployment and skips unchanged assets but always uploads main", async () => {
  const h = await fixture();
  const undeployable = { ...h.result };
  delete undeployable.deploy;
  await expect(readDeploymentSnapshot(undeployable, "ev3")).rejects.toThrow("BUILD1005");
  h.session.list.mockResolvedValue(
    [1, 2].map((byte, index) => ({
      name: `${index ? "b" : "a"}.bin`,
      path: `/robot/${index ? "b" : "a"}.bin`,
      kind: "file" as const,
      size: 1,
      checksum: createHash("md5")
        .update(new Uint8Array([byte]))
        .digest("hex"),
    })),
  );
  await h.service.deploy(h.id, "build", "/robot");
  expect(h.session.list).toHaveBeenCalledTimes(1);
  expect(h.session.upload.mock.calls.map(([name]) => name)).toEqual(["/robot/main.bin"]);
});

it("uses the main basename in the deployment namespace", async () => {
  const h = await fixture();
  const main = h.result.artifacts.find((item) => item.role === "deploy-main")!;
  main.remotePath = "ignored/main.bin";
  const files = await readDeploymentSnapshot(h.result, "ev3");
  expect(files.map((file) => [file.role, file.remotePath])).toEqual([
    ["deploy-asset", "a.bin"],
    ["deploy-asset", "b.bin"],
    ["deploy-main", "main.bin"],
  ]);
});
