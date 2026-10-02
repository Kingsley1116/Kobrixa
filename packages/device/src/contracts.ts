export type DeviceErrorCategory =
  | "permission"
  | "not-found"
  | "connection"
  | "timeout"
  | "protocol"
  | "transfer"
  | "device"
  | "cancelled"
  | "internal";

export interface DeviceDescriptor {
  id: string;
  name: string;
  transport: "usb" | "wifi" | "mock";
  address?: string;
  serialNumber?: string;
  metadata?: Record<string, string>;
}

export interface DeviceTransport {
  discover(signal: AbortSignal): Promise<DeviceDescriptor[]>;
  connect(target: DeviceDescriptor, signal: AbortSignal): Promise<DeviceSession>;
}

export interface RemoteEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  checksum?: string;
}
export type TransferProgress = (transferred: number, total: number) => void;

export interface DeviceSession {
  readonly descriptor: DeviceDescriptor;
  readonly connected: boolean;
  onDisconnect?(listener: (error: Error) => void): () => void;
  disconnect(): Promise<void>;
  upload(remotePath: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
  list(directory: string, signal: AbortSignal): Promise<RemoteEntry[]>;
  download(
    remotePath: string,
    sink: (chunk: Uint8Array) => Promise<void>,
    signal: AbortSignal,
    progress?: TransferProgress,
  ): Promise<void>;
  uploadStream(
    remotePath: string,
    size: number,
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    progress?: TransferProgress,
  ): Promise<void>;
  createDirectory(remotePath: string, signal: AbortSignal): Promise<void>;
  rename(source: string, destination: string, signal: AbortSignal): Promise<void>;
  run(remotePath: string, signal: AbortSignal): Promise<void>;
  stop(programName?: string, signal?: AbortSignal): Promise<void>;
  delete(remotePath: string, signal: AbortSignal): Promise<void>;
}

export interface Ev3Connection {
  onDisconnect?(listener: (error: Error) => void): () => void;
  exchange(payload: Uint8Array, signal: AbortSignal, timeoutMs?: number): Promise<Uint8Array>;
  transmit(payload: Uint8Array, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
