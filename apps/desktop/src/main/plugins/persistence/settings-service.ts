import type { BoundSettingsService, CommonEventLedgerPort } from "@kobrixa/plugin-runtime";
import type { PersistenceBackend } from "./engine-port.js";
import type { PersistenceSourcePort } from "./host-port.js";
export declare function createBoundSettingsService(input:{backend:PersistenceBackend;sources:PersistenceSourcePort;events:CommonEventLedgerPort;now:()=>number}):BoundSettingsService;
