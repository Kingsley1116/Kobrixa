import type { Durability } from "@kobrixa/plugin-protocol";
export declare const storeRootBrand: unique symbol;
export type StoreRoot = {readonly [storeRootBrand]:true};
export declare const storePathBrand: unique symbol;
export declare const storeFdBrand: unique symbol;
export type StorePath = { readonly [storePathBrand]: true };
export type StoreFd = { readonly [storeFdBrand]: true };
export type PersistenceFaultPoint =
  | "reserve"
  | "open-temp"
  | "chunk-write"
  | "seal-sync"
  | "object-rename"
  | "object-dir-sync"
  | "backup-head"
  | "head-write"
  | "before-publish"
  | "after-publish"
  | "head-dir-sync"
  | "cache-publish"
  | "receipt-send"
  | "cleanup"
  | "import-marker";
export interface PersistenceFsPort {
  readonly durability: Durability;
  now(): number;
  open(path: StorePath, mode: "read" | "create-exclusive"): Promise<StoreFd>;
  read(fd: StoreFd, offset: number, maxBytes: number): Promise<Uint8Array>;
  write(fd: StoreFd, offset: number, bytes: Uint8Array): Promise<number>;
  sync(fd: StoreFd): Promise<void>;
  close(fd: StoreFd): Promise<void>;
  syncDirectory(path: StorePath): Promise<void>;
  atomicReplace(from: StorePath, to: StorePath): Promise<void>;
  mkdir(path: StorePath): Promise<void>;
  statfs(path: StorePath): Promise<{ availableBytes: number }>;
  unlink(path: StorePath): Promise<void>;
  fault(point: PersistenceFaultPoint): Promise<void>;
}

import type { ProfileWriterLock } from "@kobrixa/plugin-runtime";
export declare function openStoreRoot(input: {userData: string; profile: ProfileWriterLock}): Promise<StoreRoot>;
