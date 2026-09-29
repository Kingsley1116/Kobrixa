import { GalleryError } from "../../shared/gallery.js";
import type { GalleryErrorCode } from "../../shared/gallery.js";
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, { ...init, credentials: "same-origin" });
  const data = await response.json();
  if (!response.ok)
    throw new GalleryError((data.error ?? "internal") as GalleryErrorCode, response.status);
  return data as T;
}
export function errorText(error: unknown, t: (zh: string, en: string) => string) {
  const code = error instanceof GalleryError ? error.code : "internal";
  const messages: Record<GalleryErrorCode, [string, string]> = {
    invalid: ["請檢查欄位與檔案內容。", "Check the fields and file contents."],
    unsupported: [
      "不支援此格式。RSF 必須為 8 kHz 未壓縮音訊。",
      "Unsupported format. RSF must be uncompressed 8 kHz audio.",
    ],
    too_large: [
      "檔案或音訊範圍超過上限（最長 60 秒）。",
      "The file or audio selection exceeds the limit (60 seconds maximum).",
    ],
    unauthorized: ["請先以 GitHub 登入。", "Please sign in with GitHub."],
    forbidden: ["你沒有執行此操作的權限。", "You do not have permission for this action."],
    not_found: ["找不到作品，或作品尚未公開。", "This work is unavailable or not public."],
    conflict: [
      "作品狀態已變更，請重新載入後再試。",
      "This work has changed. Reload before trying again.",
    ],
    quota: [
      "已達今日額度，請明天再試（每日最多送審 20 件）。",
      "Today's limit has been reached. Try tomorrow (20 submissions per day).",
    ],
    unavailable: [
      "服務尚未設定完成或檔案暫時無法取得，請稍後再試。",
      "The service is not configured or the file is temporarily unavailable. Try again later.",
    ],
    internal: [
      "無法完成操作，請檢查連線後重試。",
      "The request failed. Check your connection and try again.",
    ],
  };
  return t(...messages[code]);
}
