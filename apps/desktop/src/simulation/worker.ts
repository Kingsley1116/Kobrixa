import type { SimulationCommand } from "../shared/simulator.js";
import { SimulationWorkerSession } from "./worker-session.js";

// Bundled module worker; never imports Electron, Node or physical-device transports.
const session = new SimulationWorkerSession((response) => self.postMessage(response));
self.onmessage = (event: MessageEvent<SimulationCommand>) => session.receive(event.data);
