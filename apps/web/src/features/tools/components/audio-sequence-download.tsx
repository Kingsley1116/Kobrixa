import { useMemo } from "react";
import { DownloadCard, useBlobUrl } from "./tools-ui.js";
import type { Translate } from "./tools-ui.js";
import { segmentName, sequenceProgram } from "../lib/audio-segments.js";
import { mediaZip } from "../lib/media-zip.js";
import { SAMPLE_RATE } from "../lib/media.js";
import { validFileName } from "../lib/tools-state.js";
import type { ExportState } from "../lib/tools-state.js";

const instructions = `Kobrixa — Sequential RSF playback / RSF 順序播放

1. Copy assets/deploy into your project's assets/deploy folder.
   將 assets/deploy 內的音檔複製到專案的 assets/deploy 資料夾。
2. Add "assets/deploy/**/*" to the assets list in kobrixa.json.
   在 kobrixa.json 的 assets 清單加入 "assets/deploy/**/*"。
3. Copy play-sequence.bp into your Basic Plus entry program, then upload the project to EV3.
   將 play-sequence.bp 的程式碼加入 Basic Plus 主程式，再上傳專案到 EV3。

Each Speaker.Wait() finishes one file before the next Speaker.Play().
每次 Speaker.Wait() 會等待上一個檔案播完，再播放下一段。
EV3 may pause briefly at file boundaries. Gapless playback is not guaranteed.
EV3 換檔時可能短暫停頓，並非保證無縫播放。
Normalization applies to the whole selection; fades only apply at its beginning/end.
正規化套用於整個選取範圍；淡入／淡出只在整段的開頭與結尾套用。
Browser preview does not simulate the brick's file-loading delays.
瀏覽器試聽不模擬 EV3 的檔案載入延遲。
`;

function PartDownload({
  bytes,
  name,
  ready,
  t,
}: {
  bytes: Uint8Array<ArrayBuffer>;
  name: string;
  ready: boolean;
  t: Translate;
}) {
  const blob = useMemo(() => new Blob([bytes], { type: "application/octet-stream" }), [bytes]);
  const url = useBlobUrl(blob);
  return (
    <li>
      <span className="segment-filename">{name}.rsf</span>
      <span>{((bytes.length - 8) / SAMPLE_RATE).toFixed(3)} s</span>
      {ready && url ? (
        <a
          className="studio-text-button"
          href={url}
          download={`${name}.rsf`}
          aria-label={t(`下載 ${name}.rsf`, `Download ${name}.rsf`)}
        >
          {t("下載", "Download")}
        </a>
      ) : (
        <button className="studio-text-button" disabled>
          {t("下載", "Download")}
        </button>
      )}
    </li>
  );
}

export function AudioSequenceDownload({
  parts,
  name,
  setName,
  state,
  t,
}: {
  parts: Uint8Array<ArrayBuffer>[] | undefined;
  name: string;
  setName: (name: string) => void;
  state: ExportState;
  t: Translate;
}) {
  const archive = useMemo(() => {
    if (!parts || !validFileName(name)) return undefined;
    try {
      const code = sequenceProgram(name, parts.length);
      const bytes = mediaZip([
        ...parts.map((bytes, index) => ({
          name: `assets/deploy/${segmentName(name, index)}.rsf`,
          bytes,
        })),
        { name: "play-sequence.bp", bytes: new TextEncoder().encode(code) },
        { name: "README.txt", bytes: new TextEncoder().encode(instructions) },
      ]);
      return { bytes, code };
    } catch {
      return undefined;
    }
  }, [parts, name]);
  const failed = state === "ready" && !archive;
  return (
    <DownloadCard
      bytes={archive?.bytes}
      name={name}
      setName={setName}
      extension="zip"
      state={failed ? "error" : state}
      t={t}
      usageCode={archive?.code ?? ""}
      usageIntro={t(
        "解壓縮後，將 assets/deploy 內的音檔放入專案相同資料夾，並在 kobrixa.json 的 assets 加入 assets/deploy/**/*。將 play-sequence.bp 的程式碼加入主程式，上傳專案後即可依序播放。",
        "Unzip and copy the audio files from assets/deploy into the same folder in your project. Include assets/deploy/**/* in kobrixa.json's assets list. Add play-sequence.bp to your entry program, then upload the project to play the files in order.",
      )}
    >
      <p className="control-hint">
        {t(
          "ZIP 包含依序編號的 RSF、play-sequence.bp 與使用說明；上方檔名也會作為各片段的前綴。",
          "The ZIP includes numbered RSF files, play-sequence.bp and instructions. The file name above is also the prefix for each part.",
        )}
      </p>
      {failed && (
        <p className="studio-error" role="alert">
          {t(
            "無法打包，請縮短選取範圍後重試。",
            "Could not create the archive. Shorten the selection and try again.",
          )}
        </p>
      )}
      {parts && validFileName(name) && (
        <details className="segment-details">
          <summary className="ui-disclosure">
            {t(
              `${parts.length} 個音檔・個別下載`,
              `${parts.length} audio files · individual downloads`,
            )}
          </summary>
          <ol className="segment-files">
            {parts.map((bytes, index) => (
              <PartDownload
                key={index}
                bytes={bytes}
                name={segmentName(name, index)}
                ready={state === "ready"}
                t={t}
              />
            ))}
          </ol>
        </details>
      )}
      <p className="studio-warning">
        {t(
          "EV3 換檔時可能短暫停頓；瀏覽器試聽不模擬這段延遲，不保證無縫播放。",
          "EV3 may pause briefly between files. Browser preview does not simulate this delay; gapless playback is not guaranteed.",
        )}
      </p>
    </DownloadCard>
  );
}
