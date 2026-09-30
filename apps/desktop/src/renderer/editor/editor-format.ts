import * as monaco from "monaco-editor";
import { formatBasicPlus } from "@kobrixa/basic-plus/language";
interface JsonEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}
interface JsonFormatter {
  format(
    uri: string,
    range: undefined,
    options: { tabSize: number; insertSpaces: boolean },
  ): Promise<JsonEdit[]>;
}
let request = 0;
/** Format a snapshot, including recovered files that are not currently open. */
export async function formatSource(
  file: string,
  source: string,
  indentSize: 2 | 4,
): Promise<string> {
  if (/\.(bp|bpi|bpm)$/i.test(file)) return formatBasicPlus(source, { indentSize });
  if (!/\.json$/i.test(file)) return source;
  const uri = monaco.Uri.from({ scheme: "kobrixa-format", path: `/${++request}/${file}` });
  const model = monaco.editor.createModel(source, "json", uri);
  try {
    const factory = await monaco.languages.json.getWorker();
    // Monaco 0.52.2's JSON worker exposes format, but omits it from IJSONWorker.
    const worker = (await factory(uri)) as unknown as JsonFormatter;
    const edits = await worker.format(uri.toString(), undefined, {
      tabSize: indentSize,
      insertSpaces: true,
    });
    model.applyEdits(
      edits.map((edit) => ({
        range: new monaco.Range(
          edit.range.start.line + 1,
          edit.range.start.character + 1,
          edit.range.end.line + 1,
          edit.range.end.character + 1,
        ),
        text: edit.newText,
      })),
    );
    return model.getValue();
  } finally {
    model.dispose();
  }
}
