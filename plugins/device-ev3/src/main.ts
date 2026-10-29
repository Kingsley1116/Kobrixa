import { runPlugin } from "@kobrixa/plugin-sdk";
import { createDevicePlugin } from "./controller.js";
void runPlugin(createDevicePlugin());
