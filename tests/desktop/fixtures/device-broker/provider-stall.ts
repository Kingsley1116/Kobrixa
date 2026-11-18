import { writeFileSync } from "node:fs";
const marker = process.argv[2];
if (!marker) throw new Error("Missing stall marker path");
writeFileSync(marker, JSON.stringify({ pid: process.pid, state: "entered" }));
for (;;) Math.imul(2_147_483_647, 2_147_483_647);
