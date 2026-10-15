import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from "electron";
import type { PluginLocale } from "@kobrixa/plugin-protocol";

export interface LinkPreview {
  name: string;
  id: string;
  runtime?: string;
  directory: string;
  problems: string[];
}
/** Native dialogs owned by main; the smoke test injects fakes with the same shape. */
export interface PluginDialogs {
  confirmDeveloperMode(): Promise<boolean>;
  chooseFolder(): Promise<string | undefined>;
  confirmLink(preview: LinkPreview): Promise<boolean>;
  confirmUnlink(preview: { name: string; directory: string }): Promise<boolean>;
  choosePython(): Promise<string | undefined>;
}

const copy = {
  en: {
    cancel: "Cancel",
    developerTitle: "Turn on developer mode?",
    developerDetail:
      "Developer mode runs the code in the plugin folders you link as normal programs on this computer, with your permissions. It is not a sandbox. Link only folders you trust.",
    turnOn: "Turn on",
    chooseFolder: "Choose a plugin folder",
    linkTitle: (name: string) => `Link “${name}”?`,
    id: "ID: ",
    runtime: "Runtime: ",
    folder: "Folder: ",
    problem: "Problem: ",
    unknown: "unknown",
    trust: "Its code will run on this computer. Link only plugins you trust.",
    link: "Link",
    unlinkTitle: (name: string) => `Unlink “${name}”?`,
    unlinkDetail: "Kobrixa stops the plugin and forgets the folder. No files are deleted.",
    unlink: "Unlink",
    choosePython: "Choose a Python interpreter",
  },
  "zh-TW": {
    cancel: "取消",
    developerTitle: "開啟開發者模式？",
    developerDetail:
      "開發者模式會以你的權限，把你連結的插件資料夾當作一般程式在這部電腦上執行。這不是沙箱，請只連結你信任的資料夾。",
    turnOn: "開啟",
    chooseFolder: "選擇插件資料夾",
    linkTitle: (name: string) => `連結「${name}」？`,
    id: "ID：",
    runtime: "執行環境：",
    folder: "資料夾：",
    problem: "問題：",
    unknown: "未知",
    trust: "它的程式碼會在這部電腦上執行，請只連結你信任的插件。",
    link: "連結",
    unlinkTitle: (name: string) => `解除連結「${name}」？`,
    unlinkDetail: "Kobrixa 會停止這個插件並移除連結，不會刪除任何檔案。",
    unlink: "解除連結",
    choosePython: "選擇 Python 直譯器",
  },
} as const;

export function electronPluginDialogs(
  window: () => BrowserWindow | undefined,
  locale: PluginLocale,
): PluginDialogs {
  const t = copy[locale];
  const parent = () => {
    const target = window();
    return target && !target.isDestroyed() ? target : undefined;
  };
  const confirm = async (options: {
    message: string;
    detail: string;
    accept: string;
    warning?: boolean;
  }) => {
    const box: MessageBoxOptions = {
      type: options.warning ? "warning" : "question",
      message: options.message,
      detail: options.detail,
      buttons: [options.accept, t.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const target = parent();
    const result = target
      ? await dialog.showMessageBox(target, box)
      : await dialog.showMessageBox(box);
    return result.response === 0;
  };
  const choose = async (options: OpenDialogOptions) => {
    const target = parent();
    const result = target
      ? await dialog.showOpenDialog(target, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  };
  return {
    confirmDeveloperMode: () =>
      confirm({
        message: t.developerTitle,
        detail: t.developerDetail,
        accept: t.turnOn,
        warning: true,
      }),
    chooseFolder: () => choose({ title: t.chooseFolder, properties: ["openDirectory"] }),
    confirmLink: (preview) =>
      confirm({
        message: t.linkTitle(preview.name),
        detail: [
          `${t.id}${preview.id}`,
          `${t.runtime}${preview.runtime ?? t.unknown}`,
          `${t.folder}${preview.directory}`,
          ...preview.problems.map((problem) => `${t.problem}${problem}`),
          "",
          t.trust,
        ].join("\n"),
        accept: t.link,
      }),
    confirmUnlink: (preview) =>
      confirm({
        message: t.unlinkTitle(preview.name),
        detail: `${t.unlinkDetail}\n${t.folder}${preview.directory}`,
        accept: t.unlink,
      }),
    choosePython: () => choose({ title: t.choosePython, properties: ["openFile"] }),
  };
}
