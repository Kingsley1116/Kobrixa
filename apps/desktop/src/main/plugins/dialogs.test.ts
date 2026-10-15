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
