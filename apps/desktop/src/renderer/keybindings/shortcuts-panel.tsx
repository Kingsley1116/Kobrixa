import { Dialog, DialogActions } from "../components/dialog.js";
import { useMemo, useRef, useState } from "react";
import {
  bindingProblem,
  commandLabel,
  type KeyboardCommand,
  type KeySequence,
} from "./keybindings.js";
import { contextsOverlap } from "./monaco-keybindings.js";
import type { KeyboardSettings } from "./keyboard-state.js";
import type { Locale } from "../i18n/copy.js";
import { ActionMenu } from "../components/action-menu.js";
import { Picker } from "../components/picker.js";
import { ShortcutKeys } from "./shortcut-keys.js";
import { ShortcutRecorder } from "./shortcut-recorder.js";
import {
  detailedConflicts,
  EMPTY_SHORTCUT_FILTER,
  filterShortcuts,
  shortcutStatus,
  uniqueSequences,
  type ShortcutFilter,
} from "./shortcut-search.js";
import type { RecordingState } from "./shortcut-recording.js";

interface EditDraft {
  command: KeyboardCommand;
  kind: "edit" | "reset";
  keys: KeySequence;
  mode: 1 | 2;
}
export function ShortcutsPanel({
  keyboard,
  locale,
}: {
  keyboard: KeyboardSettings;
  locale: Locale;
}) {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  const [filter, setFilter] = useState<ShortcutFilter>(EMPTY_SHORTCUT_FILTER);
  const [stack, setStack] = useState<EditDraft[]>([]);
  const [searching, setSearching] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<
    { command: KeyboardCommand; action: "set" | "reset" | "unbind" } | "resetAll"
  >();
  const search = useRef<HTMLInputElement>(null);
  const editing = stack.at(-1);
  const filtered = useMemo(
    () => filterShortcuts(keyboard.commands, keyboard.overrides, filter, locale, keyboard.mac),
    [keyboard.commands, keyboard.overrides, filter, locale, keyboard.mac],
  );
  const modified = Object.keys(keyboard.overrides).length;
  const candidates = editing
    ? editing.kind === "reset"
      ? uniqueSequences(editing.command, {})
      : editing.keys.length
        ? [editing.keys]
        : []
    : [];
  const conflicts = editing
    ? detailedConflicts(
        editing.command,
        candidates,
        keyboard.commands,
        keyboard.overrides,
        contextsOverlap,
      ).filter(
        (item) => editing.kind !== "reset" || keyboard.overrides[item.command.id] !== undefined,
      )
    : [];
  const closeEditor = () => setStack((value) => value.slice(0, -1));
  const updateDraft = (state: RecordingState) =>
    setStack((value) =>
      value.map((draft, i) =>
        i === value.length - 1 ? { ...draft, keys: state.keys, mode: state.mode } : draft,
      ),
    );
  const edit = (command: KeyboardCommand, nested = false) => {
    const bindings = uniqueSequences(command, keyboard.overrides);
    const draft: EditDraft = {
      command,
      kind: "edit",
      mode: bindings[0]?.length === 2 ? 2 : 1,
      keys: [],
    };
    setStack((value) => (nested ? [...value, draft] : [draft]));
  };
  const unbind = (command: KeyboardCommand) => {
    keyboard.store.set(command.id, []);
    setNotice({ command, action: "unbind" });
  };
  const reset = (command: KeyboardCommand) => {
    const conflicts = detailedConflicts(
      command,
      uniqueSequences(command, {}),
      keyboard.commands,
      keyboard.overrides,
      contextsOverlap,
    ).filter((item) => keyboard.overrides[item.command.id] !== undefined);
    if (conflicts.length) setStack([{ command, kind: "reset", keys: [], mode: 1 }]);
    else {
      keyboard.store.set(command.id, undefined);
      setNotice({ command, action: "reset" });
    }
  };
  const apply = () => {
    if (!editing || conflicts.length) return;
    const defaults = uniqueSequences(editing.command, {});
    const unchanged = defaults.length === 1 && defaults[0]!.join(" ") === editing.keys.join(" ");
    keyboard.store.set(
      editing.command.id,
      editing.kind === "reset" || unchanged ? undefined : [editing.keys],
    );
    setNotice({ command: editing.command, action: editing.kind === "reset" ? "reset" : "set" });
    closeEditor();
  };
  const bindingsView = (bindings: KeySequence[]) =>
    bindings.length ? (
      bindings.map((keys) => (
        <ShortcutKeys key={keys.join(" ")} keys={keys} mac={keyboard.mac} locale={locale} />
      ))
    ) : (
      <span className="shortcut-unassigned">{t("未設定", "Unassigned")}</span>
    );
  const conflictView = conflicts.length > 0 && (
    <section className="shortcut-conflicts" role="alert">
      <h3>{t("請先處理衝突", "Resolve conflicts first")}</h3>
      <p>
        {t(
          "可在此修改或解除衝突項目，再回來套用目前按鍵。",
          "Change or unbind a conflicting shortcut here, then return to apply this one.",
        )}
      </p>
      <ul>
        {conflicts.map(({ command, keys, reason }) => (
          <li key={`${command.id}-${keys.join(" ")}`}>
            <div>
              <strong>{commandLabel(command, locale)}</strong>
              <span>
                {reason === "same"
                  ? t("相同按鍵", "Same shortcut")
                  : t("連按前綴重疊", "Chord prefix overlap")}
              </span>
            </div>
            <ShortcutKeys keys={keys} mac={keyboard.mac} locale={locale} />
            <div className="shortcut-conflict-actions">
              <button
                onClick={() => edit(command, true)}
                aria-label={`${t("修改衝突", "Edit conflicting shortcut")} ${commandLabel(command, locale)}`}
              >
                {t("修改", "Edit")}
              </button>
              <button
                onClick={() => unbind(command)}
                aria-label={`${t("解除衝突", "Unbind conflicting shortcut")} ${commandLabel(command, locale)}`}
              >
                {t("解除", "Unbind")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
  const anyFilter =
    filter.query || filter.source !== "all" || filter.status !== "all" || filter.keys.length > 0;
  const statusNames = {
    default: t("預設", "Default"),
    custom: t("自訂", "Custom"),
    unassigned: t("未設定", "Unassigned"),
    unbound: t("已解除", "Unbound"),
  };
  return (
    <div className="shortcuts-panel">
      <div className="shortcut-heading">
        <div>
          <h2>{t("快捷鍵", "Keyboard shortcuts")}</h2>
          <p className="settings-hint">
            {t(
              "尋找命令，設定順手的按鍵。變更會保存在這台電腦。",
              "Find a command and make its shortcut yours. Changes are saved on this computer.",
            )}
          </p>
        </div>
        <button disabled={!modified} onClick={() => setResetting(true)}>
          {t("全部還原", "Reset all")}
          {modified ? ` (${modified})` : ""}
        </button>
      </div>
      <div className="shortcut-filters">
        <div className="shortcut-search-line">
          <input
            ref={search}
            type="search"
            aria-label={t("搜尋快捷鍵", "Search shortcuts")}
            placeholder={t(
              `搜尋中英文命令、ID 或按鍵，例如 ${keyboard.mac ? "Command" : "Ctrl"} + S`,
              `Search commands, IDs or keys, e.g. ${keyboard.mac ? "Command" : "Ctrl"} + S`,
            )}
            value={filter.query}
            onChange={(event) => setFilter({ ...filter, query: event.target.value })}
          />
          <button onClick={() => setSearching(true)}>
            {t("按快捷鍵搜尋", "Search by shortcut")}
          </button>
        </div>
        <div className="shortcut-filter-line">
          <div className="shortcut-filter">
            <label htmlFor="shortcut-source-filter">{t("來源", "Source")}</label>
            <Picker<ShortcutFilter["source"]>
              id="shortcut-source-filter"
              locale={locale}
              label={t("來源", "Source")}
              value={filter.source}
              onChange={(source) => setFilter((current) => ({ ...current, source }))}
              options={[
                { value: "all", label: t("全部來源", "All sources") },
                { value: "workbench", label: "IDE" },
                { value: "editor", label: t("編輯器", "Editor") },
              ]}
            />
          </div>
          <div className="shortcut-filter">
            <label htmlFor="shortcut-status-filter">{t("狀態", "Status")}</label>
            <Picker<ShortcutFilter["status"]>
              id="shortcut-status-filter"
              locale={locale}
              label={t("狀態", "Status")}
              value={filter.status}
              onChange={(status) => setFilter((current) => ({ ...current, status }))}
              options={[
                { value: "all", label: t("全部狀態", "All statuses") },
                { value: "modified", label: t("已修改", "Modified") },
                { value: "unassigned", label: t("未設定", "Unassigned") },
              ]}
            />
          </div>
          {filter.keys.length > 0 && (
            <div className="shortcut-search-chip">
              <ShortcutKeys keys={filter.keys} mac={keyboard.mac} locale={locale} />
              <button
                aria-label={t("清除按鍵篩選", "Clear shortcut filter")}
                onClick={() => setFilter({ ...filter, keys: [] })}
              >
                ×
              </button>
            </div>
          )}
          {anyFilter && (
            <button
              onClick={() => {
                setFilter(EMPTY_SHORTCUT_FILTER);
                search.current?.focus();
              }}
            >
              {t("清除條件", "Clear filters")}
            </button>
          )}
          <span className="shortcut-count" role="status">
            {filtered.length} / {keyboard.commands.length} {t("個命令", "commands")}
          </span>
        </div>
      </div>
      {keyboard.saveError && (
        <div role="alert" className="settings-save-error">
          {t("快捷鍵已生效，但無法保存。", "Shortcuts are active but could not be saved.")}{" "}
          <button onClick={keyboard.store.save}>{t("重試保存", "Retry saving")}</button>
        </div>
      )}
      <p role="status" className="shortcut-notice">
        {notice === "resetAll"
          ? t("已還原所有快捷鍵。", "All shortcuts restored.")
          : notice
            ? `${commandLabel(notice.command, locale)}${locale === "zh-TW" ? "：" : ": "}${{ set: t("已更新快捷鍵。", "Shortcut updated."), reset: t("已還原預設按鍵。", "Default shortcut restored."), unbind: t("已解除快捷鍵。", "Shortcut unbound.") }[notice.action]}`
            : ""}
      </p>
      <div className="shortcut-list" role="table" aria-label={t("快捷鍵命令", "Shortcut commands")}>
        <div className="shortcut-row shortcut-table-head" role="row">
          {[
            t("命令", "Command"),
            t("按鍵", "Shortcut"),
            t("來源", "Source"),
            t("狀態", "Status"),
            t("操作", "Actions"),
          ].map((label) => (
            <span role="columnheader" key={label}>
              {label}
            </span>
          ))}
        </div>
        {filtered.map((command) => {
          const bindings = uniqueSequences(command, keyboard.overrides),
            name = commandLabel(command, locale),
            status = shortcutStatus(command, keyboard.overrides);
          return (
            <div className="shortcut-row" role="row" key={command.id} data-command-id={command.id}>
              <div className="shortcut-command" role="cell">
                <details>
                  <summary title={t("展開命令詳細資訊", "Expand command details")}>{name}</summary>
                  <div className="shortcut-details">
                    <span>{commandLabel(command, "en")}</span>
                    <code>{command.id}</code>
                    <span>{t("適用條件", "Conditions")}</span>
                    {[...new Set(command.contexts.map((context) => context.when))].map((when) => (
                      <code key={when}>{when}</code>
                    ))}
                    <span>{t("預設按鍵", "Default shortcuts")}</span>
                    {bindingsView(uniqueSequences(command, {}))}
                  </div>
                </details>
              </div>
              <div className="shortcut-keys" role="cell">
                {bindingsView(bindings)}
              </div>
              <span className="shortcut-source" role="cell">
                {command.source === "workbench" ? "IDE" : t("編輯器", "Editor")}
              </span>
              <span className={`shortcut-status ${status}`} role="cell">
                {statusNames[status]}
              </span>
              <div className="shortcut-actions" role="cell">
                <button
                  onClick={() => edit(command)}
                  aria-label={`${bindings.length ? t("修改", "Edit") : t("新增快捷鍵", "Add shortcut")} ${name}`}
                >
                  {bindings.length ? t("修改", "Edit") : t("新增快捷鍵", "Add shortcut")}
                </button>
                <ActionMenu label={`${t("更多操作", "More actions")} ${name}`}>
                  <button
                    role="menuitem"
                    disabled={!bindings.length}
                    onClick={() => unbind(command)}
                  >
                    {t("解除", "Unbind")}
                  </button>
                  <button
                    role="menuitem"
                    disabled={keyboard.overrides[command.id] === undefined}
                    onClick={() => reset(command)}
                  >
                    {t("還原預設按鍵", "Reset shortcut")}
                  </button>
                </ActionMenu>
              </div>
            </div>
          );
        })}
      </div>
      {!filtered.length && (
        <div className="shortcut-empty">
          <strong>{t("沒有符合的快捷鍵", "No matching shortcuts")}</strong>
          <p>
            {t("試試其他關鍵字，或清除篩選條件。", "Try another keyword or clear the filters.")}
          </p>
          <button
            onClick={() => {
              setFilter(EMPTY_SHORTCUT_FILTER);
              search.current?.focus();
            }}
          >
            {t("清除條件", "Clear filters")}
          </button>
        </div>
      )}
      {editing && (
        <Dialog
          onClose={closeEditor}
          fallbackFocus={() => search.current?.focus()}
          title={
            <>
              {editing.kind === "reset" ? t("還原：", "Reset: ") : ""}
              {commandLabel(editing.command, locale)}
            </>
          }
          titleId="shortcut-record-title"
          className="shortcut-recorder"
        >
          {stack.length > 1 && (
            <p className="settings-hint">
              {t("完成或取消後，將返回：", "After applying or cancelling, return to: ")}
              {commandLabel(stack[stack.length - 2]!.command, locale)}
            </p>
          )}
          <dl className="shortcut-comparison">
            <div>
              <dt>{t("目前按鍵", "Current")}</dt>
              <dd>{bindingsView(uniqueSequences(editing.command, keyboard.overrides))}</dd>
            </div>
            <div>
              <dt>{t("預設按鍵", "Default")}</dt>
              <dd>{bindingsView(uniqueSequences(editing.command, {}))}</dd>
            </div>
          </dl>
          {editing.kind === "reset" ? (
            <>
              {conflictView}
              <DialogActions>
                <button onClick={closeEditor}>{t("取消", "Cancel")}</button>
                <button className="primary" disabled={conflicts.length > 0} onClick={apply}>
                  {t("還原", "Reset")}
                </button>
              </DialogActions>
            </>
          ) : (
            <ShortcutRecorder
              key={`${stack.length}-${editing.command.id}`}
              keyboard={keyboard}
              locale={locale}
              initialMode={editing.mode}
              initialKeys={editing.keys}
              onChange={updateDraft}
              onCancel={closeEditor}
            >
              {(state) => {
                const problem = bindingProblem(state.keys, keyboard.mac);
                return (
                  <>
                    {state.phase === "ready" && problem && (
                      <p role="alert">
                        {problem === "typing"
                          ? t(
                              "第一組請使用修飾鍵搭配文字鍵，或使用功能鍵。",
                              "Use a modifier with a typing key, or a function key, for the first stroke.",
                            )
                          : t(
                              "這組按鍵由系統保留或不支援。",
                              "This shortcut is reserved by the system or unsupported.",
                            )}
                      </p>
                    )}
                    {state.phase === "ready" && conflictView}
                    <DialogActions>
                      <button onClick={closeEditor}>
                        {stack.length > 1
                          ? t("取消並返回", "Cancel and return")
                          : t("取消", "Cancel")}
                      </button>
                      <button
                        className="primary"
                        disabled={
                          state.phase !== "ready" || Boolean(problem) || conflicts.length > 0
                        }
                        onClick={apply}
                      >
                        {t("套用", "Apply")}
                      </button>
                    </DialogActions>
                  </>
                );
              }}
            </ShortcutRecorder>
          )}
        </Dialog>
      )}
      {searching && (
        <Dialog
          onClose={() => setSearching(false)}
          title={t("按快捷鍵搜尋", "Search by shortcut")}
          titleId="shortcut-search-title"
          className="shortcut-recorder"
        >
          <p className="settings-hint">
            {t(
              "單組比對任一段按鍵；兩段比對完整順序。錄製時不會執行命令。",
              "A single stroke matches either part of a shortcut; two strokes match the full sequence. Commands do not run while recording.",
            )}
          </p>
          <ShortcutRecorder
            keyboard={keyboard}
            locale={locale}
            initialMode={filter.keys.length === 2 ? 2 : 1}
            initialKeys={filter.keys}
            onChange={() => {}}
            onCancel={() => setSearching(false)}
          >
            {(state) => (
              <DialogActions>
                <button onClick={() => setSearching(false)}>{t("取消", "Cancel")}</button>
                <button
                  className="primary"
                  disabled={state.phase !== "ready"}
                  onClick={() => {
                    setFilter({ ...filter, keys: state.keys });
                    setSearching(false);
                  }}
                >
                  {t("搜尋", "Search")}
                </button>
              </DialogActions>
            )}
          </ShortcutRecorder>
        </Dialog>
      )}
      {resetting && (
        <Dialog
          onClose={() => setResetting(false)}
          title={t("還原所有快捷鍵？", "Reset all shortcuts?")}
          titleId="shortcuts-reset-title"
        >
          <p>
            {t(
              "將清除所有自訂按鍵與解除綁定設定。",
              "This clears all custom bindings and unbound commands.",
            )}
          </p>
          <DialogActions>
            <button onClick={() => setResetting(false)}>{t("取消", "Cancel")}</button>
            <button
              onClick={() => {
                keyboard.store.reset();
                setNotice("resetAll");
                setResetting(false);
              }}
            >
              {t("還原", "Reset")}
            </button>
          </DialogActions>
        </Dialog>
      )}
    </div>
  );
}
