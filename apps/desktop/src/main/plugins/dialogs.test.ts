import { beforeEach, expect, it, vi } from "vitest";
import { electronPluginDialogs } from "./dialogs.js";

const { showMessageBox, showOpenDialog } = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  showOpenDialog: vi.fn(),
}));
vi.mock("electron", () => ({ dialog: { showMessageBox, showOpenDialog } }));
beforeEach(() => {
  showMessageBox.mockReset();
  showOpenDialog.mockReset();
});

it("confirms developer mode only on the first button and says it is not a sandbox", async () => {
  showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
  const dialogs = electronPluginDialogs(() => undefined, "zh-TW");
  expect(await dialogs.confirmDeveloperMode()).toBe(true);
  expect(await dialogs.confirmDeveloperMode()).toBe(false);
  const [options] = showMessageBox.mock.calls[0]!;
  expect(options).toMatchObject({ buttons: ["開啟", "取消"], defaultId: 1, cancelId: 1 });
  expect(options.detail).toContain("不是沙箱");
});

it("shows what will be linked and promises that unlinking deletes nothing", async () => {
  showMessageBox.mockResolvedValue({ response: 0 });
  const dialogs = electronPluginDialogs(() => undefined, "en");
  expect(
    await dialogs.confirmLink({
      name: "Hello",
      id: "acme.hello",
      runtime: "python",
      directory: "/p/hello",
      problems: ["The entry file is missing"],
    }),
  ).toBe(true);
  const link = showMessageBox.mock.calls.at(-1)![0];
  expect(link.message).toContain("Hello");
  for (const text of ["acme.hello", "python", "/p/hello", "The entry file is missing"])
    expect(link.detail).toContain(text);
  await dialogs.confirmUnlink({ name: "Hello", directory: "/p/hello" });
  expect(showMessageBox.mock.calls.at(-1)![0].detail).toContain("No files are deleted");
});

it("returns the chosen path, undefined when cancelled, and attaches to a live window", async () => {
  const window = { isDestroyed: () => false };
  showOpenDialog
    .mockResolvedValueOnce({ canceled: false, filePaths: ["/p/hello"] })
    .mockResolvedValueOnce({ canceled: true, filePaths: [] });
  const dialogs = electronPluginDialogs(() => window as never, "en");
  expect(await dialogs.chooseFolder()).toBe("/p/hello");
  expect(showOpenDialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ properties: ["openDirectory"] }),
  );
  expect(await dialogs.choosePython()).toBeUndefined();
  expect(showOpenDialog).toHaveBeenLastCalledWith(
    window,
    expect.objectContaining({ properties: ["openFile"] }),
  );
});

it.each(["en", "zh-TW"] as const)(
  "explains static-language editor blocking without a plugin process in %s",
  async (locale) => {
    showMessageBox.mockResolvedValue({ response: 0 });
    const dialogs = electronPluginDialogs(() => undefined, locale);
    expect(await dialogs.confirmDeveloperMode()).toBe(true);
    expect(
      await dialogs.confirmLink({
        name: "Toy",
        id: "acme.toy",
        runtime: "static",
        directory: "/p/toy",
        problems: [],
      }),
    ).toBe(true);
    const required =
      locale === "en"
        ? ["Static language rules", "block the editor", "without a plugin process"]
        : ["靜態語言規則", "編輯器無回應", "沒有插件程序"];
    for (const [options] of showMessageBox.mock.calls)
      for (const text of required) expect(options.detail).toContain(text);
    const developer = showMessageBox.mock.calls[0]![0];
    expect(developer.defaultId).toBe(1);
    expect(developer.cancelId).toBe(1);
    const link = showMessageBox.mock.calls[1]![0];
    expect(link.detail).toContain("static");
    expect(link.detail).toContain("acme.toy");
  },
);
