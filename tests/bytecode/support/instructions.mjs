// Operand layouts for the instructions understood by the test VM. Keep literal
// opcode numbers here: importing the backend's constants would hide encoding bugs.
// Reference: https://github.com/mindboards/ev3sources/blob/master/lms2012/lms2012/source/bytecodes.c
// EV3 VM types: 8/16/32 are signed integers, F is float, NO is a counted argument list.
const ops = new Map();
const subs = new Map();
const types = (layout) => (layout ? layout.split(" ").map((type) => "PAR" + type) : []);
function op(code, name, layout = "") {
  ops.set(code, { name, types: types(layout) });
}
function group(code, name, entries) {
  ops.set(code, { name, types: ["PAR8", "SUBP", name] });
  for (const [sub, label, layout = ""] of entries)
    subs.set(`${name}:${sub}`, { name: label, types: types(layout) });
}
op(0x02, "PROGRAM_STOP", "16");
op(0x05, "OBJECT_START", "16");
op(0x08, "RETURN");
op(0x09, "CALL", "16 NO");
op(0x0a, "OBJECT_END");
op(0x0b, "SLEEP");
for (const [base, name] of [
  [0x10, "ADD"],
  [0x14, "SUB"],
  [0x18, "MUL"],
  [0x1c, "DIV"],
])
  for (const [index, type] of ["8", "16", "32", "F"].entries())
    op(base + index, name + type, `${type} ${type} ${type}`);
for (const [base, name] of [
  [0x20, "OR"],
  [0x24, "AND"],
  [0x28, "XOR"],
  [0x2c, "RL"],
])
  for (const [index, type] of ["8", "16", "32"].entries())
    op(base + index, name + type, `${type} ${type} ${type}`);
for (const [i, from] of ["8", "16", "32", "F"].entries())
  for (const [j, to] of ["8", "16", "32", "F"].entries())
    op(0x30 + i * 4 + j, `MOVE${from}_${to}`, `${from} ${to}`);
op(0x40, "JR", "32");
op(0x41, "JR_FALSE", "8 32");
op(0x42, "JR_TRUE", "8 32");
for (const [i, relation] of ["LT", "GT", "EQ", "NEQ", "LTEQ", "GTEQ"].entries())
  for (const [j, type] of ["8", "16", "32", "F"].entries())
    op(0x44 + i * 4 + j, `CP_${relation}${type}`, `${type} ${type} 8`);
op(0x60, "SYSTEM", "8 32");
op(0x63, "NOTE_TO_FREQ", "8 16");
op(0x7e, "MEMORY_WRITE", "16 16 32 32 8");
op(0x7f, "MEMORY_READ", "16 16 32 32 8");
op(0x85, "TIMER_WAIT", "32 32");
op(0x86, "TIMER_READY", "32");
op(0x87, "TIMER_READ", "32");
op(0x8e, "RANDOM", "16 16 16");
op(0x95, "SOUND_TEST", "8");
op(0x96, "SOUND_READY");
op(0x9a, "INPUT_READ", "8 8 8 8 8");
op(0x9b, "INPUT_TEST", "8 8 8");
op(0x9c, "INPUT_READY", "8 8");
op(0x9d, "INPUT_READSI", "8 8 8 8 F");
op(0x9e, "INPUT_READEXT", "8 8 8 8 8 NO");
op(0x9f, "INPUT_WRITE", "8 8 8 8");
for (const [code, name, layout] of [
  [0xa1, "SET_TYPE", "8 8 8"],
  [0xa2, "RESET", "8 8"],
  [0xa3, "STOP", "8 8 8"],
  [0xa4, "POWER", "8 8 8"],
  [0xa5, "SPEED", "8 8 8"],
  [0xa6, "START", "8 8"],
  [0xa7, "POLARITY", "8 8 8"],
  [0xa8, "READ", "8 8 8 32"],
  [0xa9, "TEST", "8 8 8"],
  [0xaa, "READY", "8 8"],
  [0xac, "STEP_POWER", "8 8 8 32 32 32 8"],
  [0xae, "STEP_SPEED", "8 8 8 32 32 32 8"],
  [0xb0, "STEP_SYNC", "8 8 8 16 32 8"],
  [0xb2, "CLR_COUNT", "8 8"],
  [0xb3, "GET_COUNT", "8 8 32"],
])
  op(code, "OUTPUT_" + name, layout);
op(0xc2, "ARRAY_WRITE", "16 32 V");
op(0xc3, "ARRAY_READ", "16 32 V");
op(0xc4, "ARRAY_APPEND", "16 V");
op(0xd8, "MAILBOX_OPEN", "8 8 8 8 8");
op(0xd9, "MAILBOX_WRITE", "8 8 8 8 NO");
op(0xda, "MAILBOX_READ", "8 8 NO");
op(0xdb, "MAILBOX_TEST", "8 8");
op(0xdc, "MAILBOX_READY", "8");
group(0x7d, "STRINGS", [
  [1, "GET_SIZE", "8 16"],
  [2, "ADD", "8 8 8"],
  [3, "COMPARE", "8 8 8"],
  [5, "DUPLICATE", "8 8"],
  [6, "VALUE_TO_STRING", "F 8 8 8"],
  [7, "STRING_TO_VALUE", "8 F"],
  [8, "STRIP", "8 8"],
  [9, "NUMBER_TO_STRING", "16 8 8"],
  [10, "SUB", "8 8 8"],
  [11, "VALUE_FORMATTED", "F 8 8 8"],
  [12, "NUMBER_FORMATTED", "32 8 8 8"],
]);
group(0x81, "UI_READ", [
  [1, "GET_VBATT", "F"],
  [2, "GET_IBATT", "F"],
  [18, "GET_LBATT", "8"],
]);
group(0x82, "UI_WRITE", [[27, "LED", "8"]]);
group(0x83, "UI_BUTTON", [
  [1, "SHORTPRESS", "8 8"],
  [3, "WAIT_FOR_PRESS"],
  [4, "FLUSH"],
  [9, "PRESSED", "8 8"],
]);
group(0x84, "UI_DRAW", [
  [0, "UPDATE"],
  [1, "CLEAN"],
  [2, "PIXEL", "8 16 16"],
  [3, "LINE", "8 16 16 16 16"],
  [4, "CIRCLE", "8 16 16 16"],
  [5, "TEXT", "8 16 16 8"],
  [8, "VALUE", "8 16 16 F 8 8"],
  [9, "FILLRECT", "8 16 16 16 16"],
  [10, "RECT", "8 16 16 16 16"],
  [16, "INVERSERECT", "16 16 16 16"],
  [17, "SELECT_FONT", "8"],
  [24, "FILLCIRCLE", "8 16 16 16"],
  [28, "BMPFILE", "8 16 16 8"],
]);
group(0x8d, "MATH", [
  ...[
    [1, "EXP"],
    [3, "FLOOR"],
    [4, "CEIL"],
    [5, "ROUND"],
    [6, "ABS"],
    [8, "SQRT"],
    [9, "LOG"],
    [10, "LN"],
    [11, "SIN"],
    [12, "COS"],
    [13, "TAN"],
    [14, "ASIN"],
    [15, "ACOS"],
    [16, "ATAN"],
  ].map(([code, name]) => [code, name, "F F"]),
  [2, "MOD", "F F F"],
  [20, "POW", "F F F"],
]);
group(0x94, "SOUND", [
  [0, "BREAK"],
  [1, "TONE", "8 16 16"],
  [2, "PLAY", "8 S"],
]);
group(0x99, "INPUT_DEVICE", [
  [2, "GET_FORMAT", "8 8 8 8 8 8"],
  [5, "GET_TYPEMODE", "8 8 8 8"],
  [9, "SETUP", "8 8 8 16 8 8 8 8"],
  [11, "GET_RAW", "8 8 32"],
  [21, "GET_NAME", "8 8 8 8"],
  [27, "READY_PCT", "8 8 8 8 NO"],
  [28, "READY_RAW", "8 8 8 8 NO"],
  [29, "READY_SI", "8 8 8 8 NO"],
]);
group(0xc0, "FILE", [
  [0, "OPEN_APPEND", "8 16"],
  [1, "OPEN_READ", "8 16 32"],
  [2, "OPEN_WRITE", "8 16"],
  [5, "READ_TEXT", "16 8 16 8"],
  [6, "WRITE_TEXT", "16 8 8"],
  [7, "CLOSE", "16"],
  [28, "READ_BYTES", "16 16 8"],
  [29, "WRITE_BYTES", "16 16 8"],
]);
group(0xc1, "ARRAY", [
  [0, "DELETE", "16"],
  [1, "CREATE8", "32 16"],
  [2, "CREATE16", "32 16"],
  [3, "CREATE32", "32 16"],
  [4, "CREATEF", "32 16"],
  [5, "RESIZE", "16 32"],
  [6, "FILL", "16 V"],
  [12, "SIZE", "16 32"],
  [13, "READ_CONTENT", "16 16 32 32 8"],
  [14, "WRITE_CONTENT", "16 16 32 32 8"],
]);
group(0xc6, "FILENAME", [[23, "GET_FOLDERNAME", "8 8"]]);
group(0xd3, "COM_GET", [[13, "GET_BRICKNAME", "8 8"]]);
group(0xd4, "COM_SET", [[7, "SET_CONNECTION", "8 8 8"]]);
export const defaultTables = { ops, subs };
