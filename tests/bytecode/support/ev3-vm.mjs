// Limited EV3 interpreter for tests; device operations use deterministic stubs.
import assert from "node:assert/strict";
import fs from "node:fs";
import { inspectRbf } from "../../../packages/backend-ev3/dist/index.js";
const schema = JSON.parse(
  fs.readFileSync(new URL("../fixtures/opcodes.json", import.meta.url), "utf8"),
);
const defaultTables = { ops: new Map(schema.ops), subs: new Map(schema.subs) };
export function firmwareTables(h, c) {
  const nums = Object.fromEntries(
    [...h.matchAll(/^\s*(\w+)\s*=\s*(0x[\da-f]+|\d+)\s*,/gim)].map((m) => [m[1], Number(m[2])]),
  );
  const ops = new Map(),
    subs = new Map();
  for (const m of c.matchAll(/\bOC\(\s*(\w+)\s*,([^)]*)\)/g)) {
    if (nums[m[1]] !== undefined)
      ops.set(nums[m[1]], {
        name: m[1].slice(2),
        types: m[2]
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x !== "0"),
      });
  }
  for (const m of c.matchAll(/\bSC\(\s*(\w+)\s*,\s*(\w+)\s*,([^)]*)\)/g)) {
    if (nums[m[2]] !== undefined)
      subs.set(m[1] + ":" + nums[m[2]], {
        name: m[2],
        types: m[3]
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x !== "0"),
      });
  }
  return { ops, subs };
}
function decode(b, tables = defaultTables) {
  const { ops, subs } = tables;
  const info = inspectRbf(b);
  b = Buffer.from(b);
  const objects = [];
  for (let k = 0; k < info.objectCount; k++) {
    let p = info.offsets[k],
      end = info.offsets[k + 1] ?? b.length;
    const params = [];
    if (b.readUInt16LE(22 + k * 12) === 1) {
      const n = b[p++];
      for (let j = 0; j < n; j++) {
        const d = b[p++];
        params.push({ d, size: (d & 7) === 4 ? b[p++] : [1, 2, 4, 4][d & 7] });
      }
    }
    const start = p,
      ins = [];
    function par(t) {
      const at = p,
        x = b[p++];
      let a = { at, t };
      if (!(x & 128)) {
        if (x & 64) return { ...a, scope: x & 32 ? "g" : "l", off: x & 31 };
        return { ...a, n: x & 32 ? (x & 63) - 64 : x & 63 };
      }
      if (!(x & 64) && (x & 7) === 4) {
        const e = b.indexOf(0, p);
        if (e < 0) throw Error("unterminated string");
        a.str = b.toString("utf8", p, e);
        p = e + 1;
        return a;
      }
      const len = { 1: 1, 2: 2, 3: 4 }[x & 7];
      if (!len) throw Error("bad parameter " + x.toString(16) + " at " + at);
      if (x & 64) {
        a.scope = x & 32 ? "g" : "l";
        a.off = b.readUIntLE(p, len);
        a.handle = !!(x & 16);
      } else {
        a.n = b.readIntLE(p, len);
        if (len === 4) a.f = b.readFloatLE(p);
      }
      p += len;
      return a;
    }
    while (p < end) {
      const at = p,
        op = b[p++],
        meta = ops.get(op);
      if (!meta) throw Error("unknown opcode " + op + " at " + at);
      let name = meta.name,
        ts = [...meta.types],
        args = [];
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (t === "SUBP") {
          const sub = subs.get(ts[++i] + ":" + args.at(-1).n);
          if (!sub) throw Error("unknown subcode " + name + " " + args.at(-1).n);
          name += "." + sub.name;
          ts.push(...sub.types);
          continue;
        }
        if (t === "PARNO") {
          const n = par("PAR8");
          args.push(n);
          for (let j = 0; j < n.n; j++) args.push(par("PAR32"));
        } else args.push(par(t));
      }
      if (p > end) throw Error("instruction overruns object");
      ins.push({ at, end: p, op, name, args });
    }
    const boundaries = new Set(ins.map((x) => x.at));
    for (const i of ins) {
      if (["JR", "JR_FALSE", "JR_TRUE"].includes(i.name)) {
        const dest = i.end + i.args.at(-1).n;
        if (!boundaries.has(dest)) throw Error("jump off boundary " + i.at + " -> " + dest);
      }
    }
    objects.push({ start, end, params, ins, local: b.readUInt32LE(24 + k * 12) });
  }
  for (const object of objects)
    for (const instruction of object.ins)
      if (instruction.name === "CALL") {
        const callee = objects[instruction.args[0].n - 1];
        assert(callee, "CALL target is not an object");
        assert.equal(instruction.args[1].n, callee.params.length, "CALL parameter count");
      }
  return { info, objects };
}
class VM {
  constructor(d, scenario = {}) {
    this.d = d;
    this.s = scenario;
    this.g = Buffer.alloc(d.info.globalBytes);
    this.arrays = new Map();
    this.files = new Map();
    this.handles = new Map();
    this.next = 1;
    this.peakArrays = 0;
    this.trace = [];
    this.time = 1000;
    this.frames = [];
    this.tasks = [{ frames: this.frames, wake: 0 }];
    this.taskIndex = 0;
    this.objectMemory = d.objects.map((o) => Buffer.alloc(o.local));
    this.activeObjects = new Map();
    this.scheduler = { threadsStarted: 0, contextSwitches: 0, contendedCalls: 0 };
    this.steps = 0;
    this.covered = new Set();
    this.modes = {};
    this.finished = false;
    this.sensorReads = 0;
    this.siReads = 0;
    this.sensorMetadataReads = 0;
    this.sensorBusyReads = 0;
    this.motorReads = 0;
    this.randomReads = 0;
    this.i2cReads = 0;
    this.mailboxes = new Map();
    this.i2cMemory = new Map();
    this.start(0);
  }
  start(i, ret) {
    const o = this.d.objects[i];
    const f = { i, o, pc: o.start, l: this.objectMemory[i], ret };
    this.activeObjects.set(i, f);
    this.frames.push(f);
    return f;
  }
  f() {
    return this.frames.at(-1);
  }
  mem(a) {
    let b = a.scope === "g" ? this.g : this.f().l,
      off = a.off;
    if (a.handle) {
      const ar = this.arrays.get(b.readUInt16LE(off));
      if (!ar) throw Error("invalid handle " + off);
      b = ar.b;
      off = 0;
    }
    return { b, off };
  }
  read(a, t = a.t) {
    if (a.str !== undefined) {
      const bytes = Buffer.from(a.str + "\0\0\0\0");
      return t === "PARF"
        ? bytes.readFloatLE()
        : bytes.readIntLE(0, t === "PAR8" ? 1 : t === "PAR16" ? 2 : 4);
    }
    if (a.scope) {
      const { b, off } = this.mem(a);
      const n = t === "PAR8" ? 1 : t === "PAR16" ? 2 : 4;
      if (off + n > b.length) throw Error("memory read bounds");
      return t === "PARF" ? b.readFloatLE(off) : b.readIntLE(off, n);
    }
    if (t === "PARF") {
      if (a.f !== undefined) return a.f;
      const b = Buffer.alloc(4);
      b.writeInt32LE(a.n);
      return b.readFloatLE();
    }
    return a.n;
  }
  write(a, v, t = a.t) {
    if (!a.scope) throw Error("write to constant");
    const { b, off } = this.mem(a);
    const n = t === "PAR8" ? 1 : t === "PAR16" ? 2 : 4;
    if (off + n > b.length) throw Error("memory write bounds");
    if (t === "PARF") b.writeFloatLE(v, off);
    else b.writeUIntLE((Math.trunc(v) >>> 0) % 2 ** (n * 8), off, n);
  }
  str(a) {
    if (a.str !== undefined) return a.str;
    const { b, off } = this.mem(a);
    const end = b.indexOf(0, off);
    return b.toString("utf8", off, end < 0 ? b.length : end);
  }
  put(a, s) {
    const { b, off } = this.mem(a);
    if (off + Buffer.byteLength(s) + 1 > b.length) throw Error("string memory bounds");
    b.write(s, off);
    b[off + Buffer.byteLength(s)] = 0;
  }
  array(a) {
    const ar = this.arrays.get(this.read(a, "PAR16"));
    if (!ar) throw Error("invalid array handle " + this.read(a, "PAR16"));
    return ar;
  }
  run() {
    try {
      while (
        this.tasks.some((task) => task.frames.length) &&
        this.steps++ < (this.s.maxSteps ?? 100000) &&
        !this.finished
      ) {
        if (!this.frames.length || this.tasks[this.taskIndex].wake > this.time) this.schedule();
        const f = this.f(),
          i = f.o.ins.find((x) => x.at === f.pc);
        if (!i) throw Error("bad PC " + f.pc);
        this.covered.add(i.at);
        f.pc = i.end;
        this.execute(i);
        if (
          !this.finished &&
          (this.yielded || this.steps % (this.s.quantum ?? 7) === 0 || !this.frames.length)
        ) {
          this.schedule();
          this.yielded = false;
        }
      }
      return {
        status: this.bounded
          ? "bounded"
          : this.finished || !this.tasks.some((task) => task.frames.length)
            ? "ended"
            : "bounded",
        steps: this.steps,
        scheduler: this.scheduler,
        trace: this.trace,
        globals: this.g.toString("hex"),
        covered: this.covered.size,
        files: [...this.files].map(([name, data]) => ({ name, hex: data.toString("hex") })),
        arrays: [...this.arrays].map(([id, ar]) => ({
          id,
          type: ar.t,
          values: Array.from({ length: ar.b.length / ar.size }, (_, j) =>
            ar.t === "PARF" ? ar.b.readFloatLE(j * ar.size) : ar.b.readIntLE(j * ar.size, ar.size),
          ),
        })),
      };
    } catch (e) {
      return {
        status: "error",
        error: e.message,
        pc: this.f()?.pc,
        steps: this.steps,
        scheduler: this.scheduler,
        trace: this.trace,
        covered: this.covered.size,
      };
    }
  }
  schedule() {
    const live = this.tasks.filter((task) => task.frames.length);
    if (!live.length) return;
    if (!live.some((task) => task.wake <= this.time))
      this.time = Math.min(...live.map((task) => task.wake));
    for (let offset = 1; offset <= this.tasks.length; offset++) {
      const index = (this.taskIndex + offset) % this.tasks.length,
        task = this.tasks[index];
      if (task.frames.length && task.wake <= this.time) {
        if (index !== this.taskIndex) this.scheduler.contextSwitches++;
        this.taskIndex = index;
        this.frames = task.frames;
        return;
      }
    }
  }
  execute(i) {
    let a = i.args,
      n = i.name.replace("STRINGS.", "STRING.");
    const r = (j, t) => this.read(a[j], t),
      w = (j, v, t) => this.write(a[j], v, t),
      s = (j) => this.str(a[j]);
    if (n === "OBJECT_END") {
      const ended = this.frames.pop();
      this.activeObjects.delete(ended.i);
      return;
    }
    if (n === "PROGRAM_STOP") {
      this.finished = true;
      return;
    }
    if (n === "SLEEP") {
      this.yielded = true;
      const wakes = this.tasks
        .filter((task) => task.frames.length && task.wake > this.time)
        .map((task) => task.wake);
      if (wakes.length) this.time = Math.min(...wakes);
      return;
    }
    if (n === "JR") {
      this.f().pc += r(0);
      return;
    }
    if (n === "JR_FALSE" || n === "JR_TRUE") {
      if ((r(0) !== 0) === (n === "JR_TRUE")) this.f().pc += r(1);
      return;
    }
    if (n === "CALL") {
      const id = r(0) - 1;
      if (this.activeObjects.has(id)) {
        if (this.frames.some((frame) => frame.i === id))
          throw Error("Non-reentrant EV3 SUBCALL would deadlock");
        this.f().pc = i.at;
        this.scheduler.contendedCalls++;
        this.yielded = true;
        return;
      }
      const caller = this.f(),
        callee = this.start(id, { caller, args: a.slice(2) });
      let off = 0;
      callee.o.params.forEach((p, j) => {
        const alignment = (p.d & 7) === 4 ? 1 : p.size;
        off = Math.ceil(off / alignment) * alignment;
        if (p.d & 128) {
          const x = a[j + 2];
          const save = this.frames.pop();
          let data;
          if ((p.d & 7) === 4) data = Buffer.from(this.str(x) + "\0");
          else {
            const t = ["PAR8", "PAR16", "PAR32", "PARF"][p.d & 7];
            data = Buffer.alloc(p.size);
            const val = this.read(x, t);
            if (t === "PARF") data.writeFloatLE(val);
            else data.writeIntLE(val, 0, p.size);
          }
          this.frames.push(save);
          data.copy(callee.l, off, 0, p.size);
        }
        off += p.size;
      });
      return;
    }
    if (n === "RETURN") {
      const callee = this.frames.pop(),
        ret = callee.ret;
      this.activeObjects.delete(callee.i);
      let off = 0;
      if (ret)
        callee.o.params.forEach((p, j) => {
          const alignment = (p.d & 7) === 4 ? 1 : p.size;
          off = Math.ceil(off / alignment) * alignment;
          if (p.d & 64) {
            const dst = this.mem(ret.args[j]);
            callee.l.copy(dst.b, dst.off, off, off + p.size);
          }
          off += p.size;
        });
      return;
    }
    if (n === "OBJECT_START") {
      this.trace.push({ op: n, id: r(0) });
      const id = r(0) - 1;
      if (!this.activeObjects.has(id)) {
        const previous = this.frames;
        this.frames = [];
        this.tasks.push({ frames: this.frames, wake: 0 });
        this.start(id);
        this.frames = previous;
        this.scheduler.threadsStarted++;
      }
      return;
    }
    if (n.startsWith("MOVE")) {
      let value = r(0);
      if (a[0].t !== a[1].t) {
        const minimum = { PAR8: -128, PAR16: -32768, PAR32: -2147483648 };
        if (value === minimum[a[0].t]) value = NaN;
        if (a[1].t !== "PARF") {
          const low = minimum[a[1].t];
          value = Number.isNaN(value)
            ? low
            : Math.min(-low - 1, Math.max(low + 1, Math.trunc(value)));
        }
      }
      w(1, value);
      return;
    }
    if (n === "RANDOM") {
      const value = this.s.randomValues?.[this.randomReads++] ?? r(0);
      if (value < r(0) || value > r(1)) throw Error("random scenario outside bounds");
      w(2, value);
      this.trace.push({ op: n, min: r(0), max: r(1), value });
      return;
    }
    if (n === "RL8") {
      const value = r(0) & 255,
        shift = r(1) & 7;
      w(2, (value << shift) & 255);
      return;
    }
    if (/^(ADD|SUB|MUL|DIV)(8|16|32|F)$/.test(n)) {
      const x = r(0),
        y = r(1);
      w(
        2,
        n.startsWith("ADD")
          ? x + y
          : n.startsWith("SUB")
            ? x - y
            : n.startsWith("MUL")
              ? x * y
              : x / y,
      );
      return;
    }
    if (/^(AND|OR|XOR)(8|16|32)$/.test(n)) {
      w(2, n.startsWith("AND") ? r(0) & r(1) : n.startsWith("XOR") ? r(0) ^ r(1) : r(0) | r(1));
      return;
    }
    if (n.startsWith("CP_")) {
      const x = r(0),
        y = r(1),
        op = n.slice(3).replace(/(8|16|32|F)$/, "");
      w(
        2,
        Number({ LT: x < y, GT: x > y, LTEQ: x <= y, GTEQ: x >= y, EQ: x === y, NEQ: x !== y }[op]),
      );
      return;
    }
    if (n.startsWith("MATH.")) {
      const sub = n.split(".")[1],
        x = r(1),
        y = a.length > 3 ? r(2) : 0;
      const val = {
        ABS: () => Math.abs(x),
        SQRT: () => Math.sqrt(x),
        SIN: () => Math.sin(Math.fround((x * Math.PI) / 180)),
        COS: () => Math.cos(Math.fround((x * Math.PI) / 180)),
        TAN: () => Math.tan(Math.fround((x * Math.PI) / 180)),
        ASIN: () => (Math.asin(x) * 180) / Math.PI,
        ACOS: () => (Math.acos(x) * 180) / Math.PI,
        ATAN: () => (Math.atan(x) * 180) / Math.PI,
        POW: () => x ** y,
        MOD: () => x % y,
        FLOOR: () => Math.floor(x),
        ROUND: () => Math.round(x),
        CEIL: () => Math.ceil(x),
      }[sub];
      if (!val) throw Error("unsupported " + n);
      w(a.length - 1, val());
      return;
    }
    if (n.startsWith("STRING.")) {
      const sub = n.split(".")[1];
      if (sub === "STRING_TO_VALUE") {
        w(2, parseFloat(s(1)) || 0);
        return;
      }
      if (sub === "DUPLICATE") {
        this.put(a[2], s(1));
        return;
      }
      if (sub === "ADD") {
        this.put(a[3], s(1) + s(2));
        return;
      }
      if (sub === "STRIP") {
        this.put(a[2], s(1).trim());
        return;
      }
      if (sub === "GET_SIZE") {
        w(2, Buffer.byteLength(s(1)));
        return;
      }
      if (sub === "VALUE_FORMATTED" || sub === "NUMBER_FORMATTED") {
        const v = r(1),
          fmt = s(2);
        this.put(
          a[4],
          fmt === "%g"
            ? Number(v.toPrecision(6)).toString()
            : fmt === "%02X"
              ? (v & 255).toString(16).toUpperCase().padStart(2, "0")
              : String(v),
        );
        return;
      }
      if (sub === "COMPARE") {
        w(3, Number(s(1) === s(2)));
        return;
      }
      throw Error("unsupported " + n);
    }
    if (n === "TIMER_READ") {
      w(0, this.time);
      return;
    }
    if (n === "TIMER_WAIT") {
      w(1, this.time + r(0));
      this.trace.push({ op: n, ms: r(0) });
      return;
    }
    if (n === "TIMER_READY") {
      if (this.time < r(0)) {
        this.tasks[this.taskIndex].wake = r(0);
        this.f().pc = i.at;
        this.yielded = true;
      }
      return;
    }
    if (n.startsWith("UI_DRAW.")) {
      const sub = n.split(".")[1];
      this.trace.push({
        op: n,
        args: a
          .slice(1)
          .map((x, j) =>
            ["TEXT", "BMPFILE"].includes(sub) && j === 3 ? this.str(x) : this.read(x),
          ),
      });
      if (this.trace.length > (this.s.maxTrace ?? 10000)) {
        this.bounded = true;
        this.finished = true;
      }
      return;
    }
    if (n === "UI_READ.GET_VBATT" || n === "UI_READ.GET_IBATT") {
      w(1, n.endsWith("VBATT") ? 7.5 : 0.25);
      return;
    }
    if (n === "UI_READ.GET_LBATT") {
      w(1, 75);
      return;
    }
    if (n === "COM_GET.GET_BRICKNAME") {
      this.put(a[2], "AuditEV3");
      return;
    }
    if (n.startsWith("UI_WRITE.")) {
      this.trace.push({ op: n, args: a.slice(1).map((x) => this.read(x)) });
      return;
    }
    if (n.startsWith("UI_BUTTON.")) {
      if (n.endsWith("PRESSED") || n.endsWith("SHORTPRESS"))
        w(2, Number((this.s.buttons ?? [this.s.button ?? 2]).includes(r(1))));
      return;
    }
    if (n === "NOTE_TO_FREQ") {
      const note = s(0),
        semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
      w(
        1,
        Math.round(440 * 2 ** (((Number(note.at(-1)) + 1) * 12 + semitones[note[0]] - 69) / 12)),
      );
      return;
    }
    if (n === "SOUND_TEST") {
      w(0, this.soundBusy ?? 0);
      this.soundBusy = 0;
      return;
    }
    if (n.startsWith("SOUND")) {
      if (n === "SOUND.TONE" || n === "SOUND.PLAY") this.soundBusy = 1;
      this.trace.push({
        op: n,
        args: a
          .slice(n.includes(".") ? 1 : 0)
          .map((x) => (n === "SOUND.PLAY" && x === a[2] ? this.str(x) : (x.str ?? this.read(x)))),
      });
      return;
    }
    if (n.startsWith("OUTPUT_")) {
      if (n === "OUTPUT_GET_COUNT") {
        if (this.s.motorCounts && this.motorReads >= this.s.motorCounts.length)
          throw Error("motor scenario exhausted");
        w(2, this.s.motorCounts?.[this.motorReads++] ?? this.s.motorCount ?? 10);
      } else if (n === "OUTPUT_READ") {
        w(2, this.s.motorSpeed ?? 0);
        w(3, this.s.motorCount ?? 10);
      } else if (n === "OUTPUT_TEST") w(2, 0);
      this.trace.push({ op: n, args: a.map((x) => this.read(x)) });
      return;
    }
    if (n === "INPUT_READY") return;
    if (n === "INPUT_WRITE") {
      const data = this.mem(a[3]);
      this.trace.push({
        op: n,
        layer: r(0),
        port: r(1),
        bytes: [...data.b.subarray(data.off, data.off + r(2))],
      });
      return;
    }
    if (n === "INPUT_TEST") {
      w(2, this.s.sensorBusyValues?.[this.sensorBusyReads++] ?? this.s.sensorBusy ?? 0);
      return;
    }
    if (n === "INPUT_READ") {
      const values = this.s.sensorValues;
      if (values && this.sensorReads >= values.length) throw Error("sensor scenario exhausted");
      const value = values ? values[this.sensorReads] : (this.s.sensor ?? 42);
      this.sensorReads++;
      w(4, value);
      this.trace.push({ op: n, args: a.slice(0, 4).map((x) => this.read(x)), value });
      return;
    }
    if (n === "INPUT_DEVICE.GET_NAME") {
      this.put(a[4], "EV3-COLOR");
      return;
    }
    if (n === "INPUT_DEVICE.GET_TYPEMODE") {
      const metadata = this.s.sensorMetadata?.[this.sensorMetadataReads++];
      w(3, metadata?.type ?? this.s.sensorType ?? 29);
      w(4, metadata?.mode ?? this.modes[r(2)] ?? this.s.sensorMode ?? 0);
      return;
    }
    if (n === "INPUT_DEVICE.GET_FORMAT") {
      w(3, this.s.sensorDatasets ?? this.s.siValues?.length ?? this.s.siSamples?.[0]?.length ?? 8);
      w(4, 3);
      w(5, 8);
      w(6, 8);
      return;
    }
    if (n === "INPUT_DEVICE.READY_RAW" || n === "INPUT_READEXT") {
      const shift = n === "INPUT_READEXT" ? 0 : 1,
        idx = n === "INPUT_READEXT" ? 6 : 6;
      if (r(shift + 3) !== -1) this.modes[r(shift + 1)] = r(shift + 3);
      if (n === "INPUT_READEXT" && r(4) === 19) {
        if (this.s.siSamples && this.siReads >= this.s.siSamples.length)
          throw Error("SI sensor scenario exhausted");
        const values = this.s.siSamples?.[this.siReads] ?? this.s.siValues ?? [42.5];
        this.siReads++;
        for (let j = idx; j < a.length; j++) w(j, values[j - idx] ?? NaN, "PARF");
        this.trace.push({ op: n, layer: r(0), port: r(1), mode: r(3), format: r(4), values });
        return;
      }
      for (let j = idx; j < a.length; j++)
        w(j, this.s.rawValues?.[j - idx] ?? this.s.sensor ?? 42, "PAR32");
      return;
    }
    if (n === "INPUT_DEVICE.SETUP") {
      const src = this.mem(a[6]),
        dst = this.mem(a[8]);
      const request = [...src.b.subarray(src.off, src.off + r(5))];
      const count = r(7),
        key = `${r(1)}:${r(2)}:${request[0]}:`;
      if (count === 0) {
        request
          .slice(2)
          .forEach((value, index) => this.i2cMemory.set(key + (request[1] + index), value));
      } else {
        const reply = this.s.i2cReplies?.[this.i2cReads++];
        if (this.s.i2cReplies && (!reply || reply.length !== count))
          throw Error("I2C scenario size/exhaustion");
        // Stock d_iic reverses replies for a positive RDLNG. Scenario bytes
        // describe the device's wire order, not the firmware destination buffer.
        for (let j = 0; j < count; j++)
          dst.b[dst.off + count - 1 - j] =
            reply?.[j] ??
            (this.s.i2cMemory
              ? (this.i2cMemory.get(key + (request[1] + j)) ?? 0)
              : (this.s.i2c ?? 42));
      }
      this.trace.push({
        op: n,
        layer: r(1),
        port: r(2),
        request,
        reply: [...dst.b.subarray(dst.off, dst.off + count)],
      });
      return;
    }
    if (n === "MEMORY_READ" || n === "MEMORY_WRITE") {
      const id = r(1),
        off = r(2),
        len = r(3),
        mem = id === 0 ? this.g : this.objectMemory[id - 1];
      if (!mem) throw Error("missing object memory");
      const dst = a[4].scope ? this.mem(a[4]) : { b: Buffer.alloc(Math.max(4, len)), off: 0 };
      if (!a[4].scope) dst.b.writeInt32LE(r(4));
      if (off < 0 || len < 0 || off + len > mem.length || dst.off + len > dst.b.length)
        throw Error("memory copy bounds");
      if (n === "MEMORY_READ") mem.copy(dst.b, dst.off, off, off + len);
      else dst.b.copy(mem, off, dst.off, dst.off + len);
      return;
    }
    if (n.startsWith("ARRAY.CREATE")) {
      const size = { CREATE8: 1, CREATE16: 2, CREATE32: 4, CREATEF: 4 }[n.split(".")[1]],
        len = r(1);
      if (len < 0 || len > 10000) throw Error("invalid array size " + len);
      if (this.arrays.size >= (this.s.maxArrayHandles ?? Infinity))
        throw Error("array handle limit exceeded");
      let id = 1;
      while (this.arrays.has(id) || this.handles.has(id)) id++;
      this.next = Math.max(this.next, id + 1);
      this.arrays.set(id, {
        b: Buffer.alloc(size * len),
        size,
        t: n.endsWith("F") ? "PARF" : size === 1 ? "PAR8" : size === 2 ? "PAR16" : "PAR32",
      });
      this.peakArrays = Math.max(this.peakArrays, this.arrays.size);
      w(2, id);
      return;
    }
    if (n === "ARRAY.FILL") {
      const ar = this.array(a[1]);
      const v = r(2, ar.t);
      for (let off = 0; off < ar.b.length; off += ar.size) {
        if (ar.t === "PARF") ar.b.writeFloatLE(v, off);
        else ar.b.writeIntLE(v, off, ar.size);
      }
      return;
    }
    if (n === "ARRAY.RESIZE") {
      const ar = this.array(a[1]),
        replacement = Buffer.alloc(r(2) * ar.size);
      ar.b.copy(replacement);
      ar.b = replacement;
      return;
    }
    if (n === "ARRAY.SIZE") {
      w(2, this.array(a[1]).b.length / this.array(a[1]).size);
      return;
    }
    if (n === "ARRAY.DELETE") {
      if (!this.arrays.delete(r(1))) throw Error("invalid array deletion " + r(1));
      return;
    }
    if (n === "ARRAY.WRITE_CONTENT" || n === "ARRAY.READ_CONTENT") {
      const ar = this.array(a[2]),
        off = r(3),
        count = r(4),
        data = this.mem(a[5]);
      if (off < 0 || count < 0 || data.off + count > data.b.length)
        throw Error("array content bounds");
      if (n === "ARRAY.WRITE_CONTENT") {
        // Firmware resizes to exactly the extent of the written content.
        const replacement = Buffer.alloc(Math.ceil((off + count) / ar.size) * ar.size);
        ar.b.copy(replacement);
        ar.b = replacement;
        data.b.copy(ar.b, off, data.off, data.off + count);
      } else {
        data.b.fill(0, data.off, data.off + count);
        ar.b.copy(data.b, data.off, Math.min(off, ar.b.length), Math.min(off + count, ar.b.length));
      }
      return;
    }
    if (n === "ARRAY_READ" || n === "ARRAY_WRITE") {
      const ar = this.array(a[0]),
        off = r(1) * ar.size;
      if (off < 0 || off + ar.size > ar.b.length)
        throw Error("array bounds " + off + "/" + ar.b.length);
      if (n === "ARRAY_READ")
        w(2, ar.t === "PARF" ? ar.b.readFloatLE(off) : ar.b.readIntLE(off, ar.size), ar.t);
      else {
        const v = r(2, ar.t);
        if (ar.t === "PARF") ar.b.writeFloatLE(v, off);
        else ar.b.writeUIntLE((v >>> 0) % 2 ** (8 * ar.size), off, ar.size);
      }
      return;
    }
    if (n === "ARRAY_APPEND") {
      const ar = this.array(a[0]);
      ar.b = Buffer.concat([ar.b, Buffer.from([r(1)])]);
      return;
    }
    if (n.startsWith("FILE.OPEN_")) {
      const name = s(1),
        id = this.next++;
      if (n === "FILE.OPEN_WRITE") this.files.set(name, Buffer.alloc(0));
      this.handles.set(id, { name, p: 0 });
      w(2, id);
      if (n === "FILE.OPEN_READ") w(3, this.files.get(name)?.length ?? 0);
      return;
    }
    if (n === "FILE.CLOSE") return;
    if (n === "FILE.WRITE_TEXT" || n === "FILE.WRITE_BYTES") {
      const f = this.handles.get(r(1)),
        data =
          n === "FILE.WRITE_TEXT"
            ? Buffer.from(s(3) + "\n")
            : a[3].scope
              ? this.mem(a[3]).b.subarray(this.mem(a[3]).off, this.mem(a[3]).off + r(2))
              : Buffer.from([r(3)]);
      this.files.set(f.name, Buffer.concat([this.files.get(f.name) ?? Buffer.alloc(0), data]));
      return;
    }
    if (n === "FILE.READ_TEXT" || n === "FILE.READ_BYTES") {
      const f = this.handles.get(r(1)),
        data = this.files.get(f.name) ?? Buffer.alloc(0),
        text = n === "FILE.READ_TEXT",
        len = r(text ? 3 : 2),
        dst = this.mem(a[text ? 4 : 3]);
      let count = Math.min(len, data.length - f.p);
      if (text && r(2) !== 0) {
        const newline = data.indexOf(10, f.p);
        if (newline >= f.p && newline < f.p + count) count = newline - f.p + 1;
      }
      data.copy(dst.b, dst.off, f.p, f.p + count);
      f.p += count;
      if (text && r(2) !== 0) {
        dst.b[dst.off + count] = 0;
        this.put(a[4], this.str(a[4]).replace(/[\r\n]+$/, ""));
      }
      return;
    }
    if (n === "COM_SET.SET_CONNECTION") {
      this.trace.push({ op: n, args: [r(1), r(2), s(3)] });
      return;
    }
    if (n === "MAILBOX_OPEN") {
      this.mailboxes.set(r(0), { name: s(1), type: r(2), value: this.s.mailboxes?.[s(1)] });
      return;
    }
    if (n === "MAILBOX_TEST") {
      w(1, this.mailboxes.get(r(0))?.value !== undefined || this.s.mailboxNew ? 0 : 1);
      return;
    }
    if (n === "MAILBOX_READY") {
      if (this.mailboxes.get(r(0))?.value === undefined)
        throw Error("Mailbox wait has no incoming message");
      return;
    }
    if (n === "MAILBOX_READ") {
      const box = this.mailboxes.get(r(0));
      if (!box || box.value === undefined) throw Error("read from empty mailbox");
      if (box.type === 4) this.put(a[3], String(box.value));
      else w(3, box.value, "PARF");
      box.value = undefined;
      return;
    }
    if (n === "MAILBOX_WRITE") {
      this.trace.push({
        op: n,
        args: [s(0), r(1), s(2), r(3), r(4), r(3) === 4 ? s(5) : r(5, "PARF")],
      });
      return;
    }
    throw Error("unsupported " + n);
  }
}
export { decode, VM };
