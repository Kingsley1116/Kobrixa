// Out-of-process trace writer. EOF and stream errors propagate to the sampler.
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
const output = createWriteStream(process.argv[2], { flags: "wx" });
await once(output, "open");
process.send("ready");
process.disconnect();
await pipeline(process.stdin, output);
