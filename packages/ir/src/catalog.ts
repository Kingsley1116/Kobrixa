import type { IRPrimitiveType, IRType } from "./types.js";

export type EV3ParameterKind = IRPrimitiveType | "array";
export type EV3ParameterType = EV3ParameterKind | readonly EV3ParameterKind[];
export type EV3ReturnType = IRPrimitiveType | Extract<IRType, { kind: "array" }>;

export interface EV3OperationSignature {
  name: string;
  category:
    | "motor"
    | "sensor"
    | "display"
    | "speaker"
    | "button"
    | "file"
    | "mailbox"
    | "program"
    | "math"
    | "utility";
  parameters: readonly EV3ParameterType[];
  returns: EV3ReturnType;
}

const textConvertible = ["string", "integer", "number", "boolean"] as const;

const operations: EV3OperationSignature[] = [
  { name: "EV3.Time", category: "program", parameters: [], returns: "integer" },
  { name: "EV3.BatteryLevel", category: "program", parameters: [], returns: "integer" },
  { name: "EV3.BatteryVoltage", category: "program", parameters: [], returns: "number" },
  { name: "EV3.BatteryCurrent", category: "program", parameters: [], returns: "number" },
  { name: "EV3.BrickName", category: "program", parameters: [], returns: "string" },
  {
    name: "EV3.SetLEDColor",
    category: "program",
    parameters: ["string", "string"],
    returns: "void",
  },
  { name: "EV3.SystemCall", category: "program", parameters: ["string"], returns: "integer" },
  { name: "EV3.QueueNextCommand", category: "program", parameters: [], returns: "void" },
  { name: "Motor.Start", category: "motor", parameters: ["string", "integer"], returns: "void" },
  {
    name: "Motor.StartPower",
    category: "motor",
    parameters: ["string", "integer"],
    returns: "void",
  },
  {
    name: "Motor.StartSteer",
    category: "motor",
    parameters: ["string", "integer", "integer"],
    returns: "void",
  },
  {
    name: "Motor.StartSync",
    category: "motor",
    parameters: ["string", "integer", "integer"],
    returns: "void",
  },
  { name: "Motor.Stop", category: "motor", parameters: ["string", "boolean"], returns: "void" },
  {
    name: "Motor.Move",
    category: "motor",
    parameters: ["string", "integer", "integer", "boolean"],
    returns: "void",
  },
  {
    name: "Motor.MovePower",
    category: "motor",
    parameters: ["string", "integer", "integer", "boolean"],
    returns: "void",
  },
  {
    name: "Motor.Schedule",
    category: "motor",
    parameters: ["string", "integer", "integer", "integer", "integer", "boolean"],
    returns: "void",
  },
  {
    name: "Motor.SchedulePower",
    category: "motor",
    parameters: ["string", "integer", "integer", "integer", "integer", "boolean"],
    returns: "void",
  },
  {
    name: "Motor.ScheduleSteer",
    category: "motor",
    parameters: ["string", "integer", "integer", "integer", "boolean"],
    returns: "void",
  },
  {
    name: "Motor.ScheduleSync",
    category: "motor",
    parameters: ["string", "integer", "integer", "integer", "boolean"],
    returns: "void",
  },
  {
    name: "Motor.MoveSteer",
    category: "motor",
    parameters: ["string", "integer", "integer", "integer", "boolean"],
    returns: "void",
  },
  {
    name: "Motor.MoveSync",
    category: "motor",
    parameters: ["string", "integer", "integer", "integer", "boolean"],
    returns: "void",
  },
  { name: "Motor.ResetCount", category: "motor", parameters: ["string"], returns: "void" },
  { name: "Motor.IsBusy", category: "motor", parameters: ["string"], returns: "boolean" },
  { name: "Motor.Wait", category: "motor", parameters: ["string"], returns: "void" },
  { name: "Motor.Invert", category: "motor", parameters: ["string"], returns: "void" },
  { name: "Motor.GetCount", category: "motor", parameters: ["string"], returns: "integer" },
  { name: "Motor.GetSpeed", category: "motor", parameters: ["string"], returns: "integer" },
  {
    name: "Sensor.ReadPercent",
    category: "sensor",
    parameters: ["integer"],
    returns: "integer",
  },
  { name: "Sensor.GetName", category: "sensor", parameters: ["integer"], returns: "string" },
  { name: "Sensor.GetType", category: "sensor", parameters: ["integer"], returns: "integer" },
  { name: "Sensor.GetMode", category: "sensor", parameters: ["integer"], returns: "integer" },
  { name: "Sensor.IsBusy", category: "sensor", parameters: ["integer"], returns: "boolean" },
  {
    name: "Sensor.ReadRaw",
    category: "sensor",
    parameters: ["integer", "integer"],
    returns: { kind: "array", element: "number" },
  },
  {
    name: "Sensor.ReadRawValue",
    category: "sensor",
    parameters: ["integer", "integer"],
    returns: "integer",
  },
  {
    name: "Sensor.ReadSIValue",
    category: "sensor",
    parameters: ["integer", "integer"],
    returns: "number",
  },
  {
    name: "Sensor.SetMode",
    category: "sensor",
    parameters: ["integer", "integer"],
    returns: "void",
  },
  { name: "Sensor.Wait", category: "sensor", parameters: ["integer"], returns: "void" },
  {
    name: "Sensor.CommunicateI2C",
    category: "sensor",
    parameters: ["integer", "integer", "integer", "integer", ["integer", "array"]],
    returns: { kind: "array", element: "number" },
  },
  {
    name: "Sensor.ReadI2CRegister",
    category: "sensor",
    parameters: ["integer", "integer", "integer"],
    returns: "integer",
  },
  {
    name: "Sensor.ReadI2CRegisters",
    category: "sensor",
    parameters: ["integer", "integer", "integer", "integer"],
    returns: { kind: "array", element: "number" },
  },
  {
    name: "Sensor.WriteI2CRegister",
    category: "sensor",
    parameters: ["integer", "integer", "integer", "integer"],
    returns: "void",
  },
  {
    name: "Sensor.WriteI2CRegisters",
    category: "sensor",
    parameters: ["integer", "integer", "integer", "integer", ["integer", "array"]],
    returns: "void",
  },
  {
    name: "Sensor.SendUARTData",
    category: "sensor",
    parameters: ["integer", "integer", ["integer", "array"]],
    returns: "void",
  },
  { name: "LCD.Clear", category: "display", parameters: [], returns: "void" },
  {
    name: "LCD.Pixel",
    category: "display",
    parameters: ["integer", "integer", "integer"],
    returns: "void",
  },
  {
    name: "LCD.Write",
    category: "display",
    parameters: ["integer", "integer", ["string", "integer", "number"]],
    returns: "void",
  },
  {
    name: "LCD.Text",
    category: "display",
    parameters: ["integer", "integer", "integer", "integer", ["string", "integer", "number"]],
    returns: "void",
  },
  {
    name: "LCD.Line",
    category: "display",
    parameters: ["integer", "integer", "integer", "integer", "integer"],
    returns: "void",
  },
  {
    name: "LCD.Circle",
    category: "display",
    parameters: ["integer", "integer", "integer", "integer"],
    returns: "void",
  },
  {
    name: "LCD.FillRect",
    category: "display",
    parameters: ["integer", "integer", "integer", "integer", "integer"],
    returns: "void",
  },
  {
    name: "LCD.Rect",
    category: "display",
    parameters: ["integer", "integer", "integer", "integer", "integer"],
    returns: "void",
  },
  {
    name: "LCD.InverseRect",
    category: "display",
    parameters: ["integer", "integer", "integer", "integer"],
    returns: "void",
  },
  {
    name: "LCD.FillCircle",
    category: "display",
    parameters: ["integer", "integer", "integer", "integer"],
    returns: "void",
  },
  {
    name: "LCD.BmpFile",
    category: "display",
    parameters: ["integer", "integer", "integer", "string"],
    returns: "void",
  },
  { name: "LCD.Update", category: "display", parameters: [], returns: "void" },
  {
    name: "Speaker.Tone",
    category: "speaker",
    parameters: ["integer", "integer", "integer"],
    returns: "void",
  },
  { name: "Speaker.Play", category: "speaker", parameters: ["integer", "string"], returns: "void" },
  { name: "Speaker.Stop", category: "speaker", parameters: [], returns: "void" },
  {
    name: "Speaker.Note",
    category: "speaker",
    parameters: ["integer", "string", "integer"],
    returns: "void",
  },
  { name: "Speaker.IsBusy", category: "speaker", parameters: [], returns: "boolean" },
  { name: "Speaker.Wait", category: "speaker", parameters: [], returns: "void" },
  { name: "Buttons.Wait", category: "button", parameters: [], returns: "void" },
  { name: "Buttons.Flush", category: "button", parameters: [], returns: "void" },
  { name: "Buttons.GetClicks", category: "button", parameters: [], returns: "string" },
  { name: "Buttons.Current", category: "button", parameters: [], returns: "string" },
  { name: "Button.IsPressed", category: "button", parameters: ["string"], returns: "boolean" },
  { name: "EV3File.OpenRead", category: "file", parameters: ["string"], returns: "integer" },
  { name: "EV3File.OpenWrite", category: "file", parameters: ["string"], returns: "integer" },
  { name: "EV3File.Close", category: "file", parameters: ["integer"], returns: "void" },
  { name: "EV3File.ReadLine", category: "file", parameters: ["integer"], returns: "string" },
  {
    name: "EV3File.WriteLine",
    category: "file",
    parameters: ["integer", "string"],
    returns: "void",
  },
  {
    name: "Mailbox.Send",
    category: "mailbox",
    parameters: ["string", "string", "string"],
    returns: "void",
  },
  { name: "Mailbox.Receive", category: "mailbox", parameters: ["integer"], returns: "string" },
  { name: "Program.Delay", category: "program", parameters: ["integer"], returns: "void" },
  { name: "Program.End", category: "program", parameters: [], returns: "void" },
  { name: "Program.GetArgument", category: "program", parameters: ["integer"], returns: "string" },
  { name: "Program.ArgumentCount", category: "program", parameters: [], returns: "integer" },
  { name: "Program.Directory", category: "program", parameters: [], returns: "string" },
];

for (let index = 1; index <= 9; index += 1) {
  operations.push({
    name: `Time.Get${index}`,
    category: "program",
    parameters: [],
    returns: "integer",
  });
  operations.push({
    name: `Time.Reset${index}`,
    category: "program",
    parameters: [],
    returns: "void",
  });
}

for (let index = 1; index <= 4; index += 1) {
  operations.push(
    { name: `Sensor${index}.Raw1`, category: "sensor", parameters: [], returns: "integer" },
    {
      name: `Sensor${index}.Raw3`,
      category: "sensor",
      parameters: ["integer", "integer", "integer"],
      returns: "void",
    },
  );
}

operations.push({ name: "Math.Pi", category: "math", parameters: [], returns: "number" });

for (const name of [
  "Abs",
  "Ceiling",
  "Floor",
  "NaturalLog",
  "Log",
  "Cos",
  "Sin",
  "Tan",
  "ArcSin",
  "ArcCos",
  "ArcTan",
  "GetDegrees",
  "GetRadians",
  "SquareRoot",
  "Round",
  "DoubleToDecimal",
] as const) {
  operations.push({
    name: `Math.${name}`,
    category: "math",
    parameters: ["number"],
    returns: "number",
  });
}

for (const name of ["Power", "Max", "Min", "Remainder"] as const) {
  operations.push({
    name: `Math.${name}`,
    category: "math",
    parameters: ["number", "number"],
    returns: "number",
  });
}

operations.push({
  name: "Math.GetRandomNumber",
  category: "math",
  parameters: ["integer"],
  returns: "integer",
});

for (const name of ["NOT", "ToLogic"] as const) {
  operations.push({
    name: `Byte.${name}`,
    category: "utility",
    parameters: [["integer", "number"]],
    returns: name === "ToLogic" ? "boolean" : "integer",
  });
}

for (const name of ["AND_", "OR_", "XOR", "BIT", "SHL", "SHR"] as const) {
  operations.push({
    name: `Byte.${name}`,
    category: "utility",
    parameters: [
      ["integer", "number"],
      ["integer", "number"],
    ],
    returns: "integer",
  });
}

for (const name of ["H", "B", "L"] as const) {
  operations.push({
    name: `Byte.${name}`,
    category: "utility",
    parameters: ["string"],
    returns: "integer",
  });
}

for (const name of ["ToHex", "ToBinary"] as const) {
  operations.push({
    name: `Byte.${name}`,
    category: "utility",
    parameters: [["integer", "number"]],
    returns: "string",
  });
}

operations.push(
  {
    name: "Text.Append",
    category: "utility",
    parameters: [textConvertible, textConvertible],
    returns: "string",
  },
  {
    name: "Text.GetLength",
    category: "utility",
    parameters: [textConvertible],
    returns: "integer",
  },
  { name: "Text.GetCharacter", category: "utility", parameters: ["integer"], returns: "string" },
  {
    name: "Text.GetCharacterCode",
    category: "utility",
    parameters: [textConvertible],
    returns: "integer",
  },
);

operations.push(
  { name: "EV3File.OpenAppend", category: "file", parameters: ["string"], returns: "integer" },
  {
    name: "EV3File.WriteByte",
    category: "file",
    parameters: ["integer", "integer"],
    returns: "void",
  },
  { name: "EV3File.ReadByte", category: "file", parameters: ["integer"], returns: "integer" },
  {
    name: "EV3File.ConvertToNumber",
    category: "file",
    parameters: [textConvertible],
    returns: "number",
  },
  {
    name: "EV3File.ReadNumberArray",
    category: "file",
    parameters: ["integer", "integer"],
    returns: { kind: "array", element: "number" },
  },
  {
    name: "EV3File.WriteNumberArray",
    category: "file",
    parameters: ["integer", "integer", ["integer", "array"]],
    returns: "void",
  },
  {
    name: "EV3File.TableLookup",
    category: "file",
    parameters: ["string", "integer", "integer", "integer"],
    returns: "integer",
  },
);

operations.push({ name: "LCD.StopUpdate", category: "display", parameters: [], returns: "void" });

operations.push(
  {
    name: "Text.IsSubText",
    category: "utility",
    parameters: [textConvertible, textConvertible],
    returns: "boolean",
  },
  {
    name: "Text.EndsWith",
    category: "utility",
    parameters: [textConvertible, textConvertible],
    returns: "boolean",
  },
  {
    name: "Text.StartsWith",
    category: "utility",
    parameters: [textConvertible, textConvertible],
    returns: "boolean",
  },
  {
    name: "Text.GetSubText",
    category: "utility",
    parameters: [textConvertible, "integer", "integer"],
    returns: "string",
  },
  {
    name: "Text.GetSubTextToEnd",
    category: "utility",
    parameters: [textConvertible, "integer"],
    returns: "string",
  },
  {
    name: "Text.GetIndexOf",
    category: "utility",
    parameters: [textConvertible, textConvertible],
    returns: "integer",
  },
  {
    name: "Text.ConvertToLowerCase",
    category: "utility",
    parameters: [textConvertible],
    returns: "string",
  },
  {
    name: "Text.ConvertToUpperCase",
    category: "utility",
    parameters: [textConvertible],
    returns: "string",
  },
);

operations.push(
  { name: "Thread.Yield", category: "program", parameters: [], returns: "void" },
  { name: "Thread.CreateMutex", category: "program", parameters: [], returns: "integer" },
  { name: "Thread.Lock", category: "program", parameters: ["integer"], returns: "void" },
  { name: "Thread.Unlock", category: "program", parameters: ["integer"], returns: "void" },
);

operations.push(
  { name: "Row.Init", category: "utility", parameters: ["integer", "number"], returns: "integer" },
  { name: "Row.Delete", category: "utility", parameters: ["integer"], returns: "void" },
  {
    name: "Row.Read",
    category: "utility",
    parameters: [["integer", "array"], "integer"],
    returns: "number",
  },
  {
    name: "Row.Write",
    category: "utility",
    parameters: [["integer", "array"], "integer", ["number", "string"]],
    returns: "void",
  },
  {
    name: "Row.Size",
    category: "utility",
    parameters: [["integer", "array"]],
    returns: "integer",
  },
  {
    name: "Row.Resize",
    category: "utility",
    parameters: [["integer", "array"], "integer"],
    returns: "void",
  },
);

operations.push(
  {
    name: "Vector.Init",
    category: "utility",
    parameters: ["integer", "number"],
    returns: { kind: "array", element: "number" },
  },
  {
    name: "Vector.Data",
    category: "utility",
    parameters: ["integer", "string"],
    returns: { kind: "array", element: "number" },
  },
  {
    name: "Vector.Add",
    category: "utility",
    parameters: ["integer", ["integer", "array"], ["integer", "array"]],
    returns: { kind: "array", element: "number" },
  },
  {
    name: "Vector.Sort",
    category: "utility",
    parameters: ["integer", ["integer", "array"]],
    returns: { kind: "array", element: "number" },
  },
  {
    name: "Vector.Multiply",
    category: "utility",
    parameters: ["integer", "integer", "integer", ["integer", "array"], ["integer", "array"]],
    returns: { kind: "array", element: "number" },
  },
);

operations.push(
  { name: "Assert.Failed", category: "utility", parameters: [textConvertible], returns: "void" },
  {
    name: "Assert.Equal",
    category: "utility",
    parameters: [textConvertible, textConvertible, textConvertible],
    returns: "void",
  },
  {
    name: "Assert.NotEqual",
    category: "utility",
    parameters: [textConvertible, textConvertible, textConvertible],
    returns: "void",
  },
  {
    name: "Assert.Less",
    category: "utility",
    parameters: ["number", "number", "string"],
    returns: "void",
  },
  {
    name: "Assert.Greater",
    category: "utility",
    parameters: ["number", "number", "string"],
    returns: "void",
  },
  {
    name: "Assert.LessEqual",
    category: "utility",
    parameters: ["number", "number", "string"],
    returns: "void",
  },
  {
    name: "Assert.GreaterEqual",
    category: "utility",
    parameters: ["number", "number", "string"],
    returns: "void",
  },
  {
    name: "Assert.Near",
    category: "utility",
    parameters: ["number", "number", "string"],
    returns: "void",
  },
);

operations.push(
  { name: "Mailbox.Create", category: "mailbox", parameters: ["string"], returns: "integer" },
  {
    name: "Mailbox.CreateForNumber",
    category: "mailbox",
    parameters: ["string"],
    returns: "integer",
  },
  {
    name: "Mailbox.SendNumber",
    category: "mailbox",
    parameters: ["string", "string", "number"],
    returns: "void",
  },
  { name: "Mailbox.IsAvailable", category: "mailbox", parameters: ["integer"], returns: "boolean" },
  {
    name: "Mailbox.ReceiveNumber",
    category: "mailbox",
    parameters: ["integer"],
    returns: "number",
  },
  { name: "Mailbox.Connect", category: "mailbox", parameters: ["string"], returns: "void" },
);

for (const ports of ["A", "B", "C", "D", "AB", "AC", "AD", "BC", "BD", "CD"] as const) {
  const prefix = `Motor${ports}`;
  for (const name of [
    "Off",
    "OffAndBrake",
    "SetSpeed",
    "SetPower",
    "Start",
    "StartSpeed",
    "StartPower",
  ] as const)
    operations.push({
      name: `${prefix}.${name}`,
      category: "motor",
      parameters: ["SetSpeed", "SetPower", "StartSpeed", "StartPower"].includes(name)
        ? ["integer"]
        : [],
      returns: "void",
    });
  if (ports.length === 1) {
    operations.push(
      { name: `${prefix}.GetTacho`, category: "motor", parameters: [], returns: "integer" },
      { name: `${prefix}.GetSpeed`, category: "motor", parameters: [], returns: "integer" },
      { name: `${prefix}.ResetCount`, category: "motor", parameters: [], returns: "void" },
      { name: `${prefix}.SetDirectPolarity`, category: "motor", parameters: [], returns: "void" },
      { name: `${prefix}.SetReversPolarity`, category: "motor", parameters: [], returns: "void" },
      { name: `${prefix}.IsLarge`, category: "motor", parameters: [], returns: "void" },
      { name: `${prefix}.IsMedium`, category: "motor", parameters: [], returns: "void" },
    );
  }
}

export const EV3_OPERATION_CATALOG = new Map(
  operations.map((operation) => [operation.name.toLocaleLowerCase("en-US"), operation] as const),
);

export function getEV3Operation(name: string): EV3OperationSignature | undefined {
  return EV3_OPERATION_CATALOG.get(name.toLocaleLowerCase("en-US"));
}
