import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL("./builtin-installed-landlock.py", import.meta.url));

test(
  "Linux installed isolation denies source and TCP after exec and in descendants",
  {
    skip: process.platform !== "linux",
  },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-landlock-"));
    const source = path.join(directory, "checkout");
    const allowed = path.join(directory, "installed.txt");
    const secret = path.join(source, "package.json");
    const server = createServer((socket) => socket.end());
    try {
      await mkdir(source);
      await writeFile(secret, "source baseline");
      await writeFile(allowed, "installed baseline");
      assert.equal(await readFile(secret, "utf8"), "source baseline");
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const program = `
import errno, json, os, socket, subprocess, sys
source, allowed, port = sys.argv[1:]
def denied(file):
    try:
        with open(file) as stream: stream.read()
        return "READABLE"
    except OSError as error: return error.errno
with open(allowed) as stream: assert stream.read() == "installed baseline"
observed = [denied(source), denied("/proc/self/root" + source)]
child = subprocess.run([sys.executable, "-c", "import sys; open(sys.argv[1]).read()", source], capture_output=True)
assert child.returncode != 0 and b"Permission denied" in child.stderr
sock = socket.socket()
try:
    sock.connect(("127.0.0.1", int(port)))
    observed.append("CONNECTED")
except OSError as error: observed.append(error.errno)
finally: sock.close()
assert observed == [errno.EACCES] * 3, observed
print(json.dumps(observed))
`;
      const { stdout } = await execute("/usr/bin/python3", [
        launcher,
        source,
        "--",
        "/usr/bin/python3",
        "-c",
        program,
        secret,
        allowed,
        String(server.address().port),
      ]);
      assert.deepEqual(JSON.parse(stdout), [13, 13, 13]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Linux isolation refuses a denied executable instead of silently running unsandboxed",
  {
    skip: process.platform !== "linux",
  },
  async () => {
    await assert.rejects(
      execute("/usr/bin/python3", [
        launcher,
        "/usr",
        "--",
        "/usr/bin/python3",
        "-c",
        "print('UNSAFE')",
      ]),
      (error) => error.stdout === "" && /inside a denied source root/.test(error.stderr),
    );
  },
);
