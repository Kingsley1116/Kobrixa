// Answers initialize and command/execute, but ignores shutdown, exit and SIGTERM on purpose.
// With the "silent" argument it never answers initialize either (a handshake that hangs).
const silent = process.argv.includes("silent");
process.on("SIGTERM", () => {});
let buffer = Buffer.alloc(0);
const reply = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: ([0-9]+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === "initialize" && !silent)
      reply({
        jsonrpc: "2.0",
        id: message.id,
        result: { apiVersion: "1.0.0", sdk: { name: "stubborn", version: "1" } },
      });
    else if (message.method === "command/execute")
      reply({ jsonrpc: "2.0", id: message.id, result: null });
  }
});
