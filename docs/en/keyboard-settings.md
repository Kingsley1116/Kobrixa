# Keyboard shortcuts and settings

Open Settings from the gear button or **Command+,** on macOS / **Ctrl+,** on Windows and Linux. Changes take effect immediately and are saved on this computer. A save-error message means the setting still applies for this session; use **Retry saving** to persist it.

## Keyboard shortcuts

Open the Keyboard shortcuts category, or press **Mod+K**, then **Mod+S** within two seconds. **Mod** means Command on macOS and Ctrl on Windows/Linux.

| Action                         | Default shortcut          |
| ------------------------------ | ------------------------- |
| New project                    | Mod+Shift+N               |
| Open project                   | Mod+O                     |
| Save                           | Mod+S                     |
| Save all                       | Mod+Shift+S               |
| Close active file/settings tab | Mod+W                     |
| Next / previous tab            | Ctrl+Tab / Ctrl+Shift+Tab |
| Settings                       | Mod+,                     |
| Keyboard shortcuts             | Mod+K, then Mod+S         |
| Toggle file tree               | Mod+B                     |
| Toggle diagnostics             | Mod+J                     |
| Toggle EV3 tools               | Mod+Shift+E               |
| Format document                | Alt+Shift+F               |
| Next / previous diagnostic     | F8 / Shift+F8             |
| Build                          | Mod+Shift+B               |
| Run on EV3                     | F5                        |
| Stop / cancel an active build  | Shift+F5                  |

Execution shortcuts use the same checks and save/build/device workflow as the toolbar. Hold-to-repeat does not start repeated operations. Unavailable commands do not bypass locks or dialogs.

The list shows all IDE and bundled Monaco editor commands, including unassigned commands. Every command has a Traditional Chinese name in the Chinese interface. Expand a command name to see its English name, ID, applicability conditions and default shortcuts. IDE commands appear first; editor commands are sorted by their names in the current language.

Search supports multiple keywords across Chinese and English names, command IDs and keys. Modifier aliases include `Cmd/Command/⌘`, `Ctrl/Control`, `Option/Alt/⌥`, `Shift/⇧` and platform-specific `Mod`. Combine searches with source (IDE or Editor) and status (Modified or Unassigned) filters. Unassigned includes intentionally unbound commands. Changing the interface language preserves your search and shortcut editing state.

**Search by shortcut** records the keys to look up. A single stroke matches either part of a shortcut; two strokes match the complete sequence in order. Recording does not run commands or change bindings. **Clear filters** returns to the full catalog.

Choose **Edit** or **Add shortcut**, select **Single stroke** or **Two strokes**, then **Start recording**. A single stroke is immediately ready to apply. For two strokes, enter the second within two seconds; a timeout keeps the preview but requires a new recording instead of silently assigning a single stroke. Escape cancels. After recording, Tab and Enter operate the dialog normally. A new binding replaces the command's defaults and retains its original applicability conditions.

Conflicts show the affected commands, their shortcuts and whether the conflict is an exact match or a chord prefix. Edit or unbind a conflicting command directly. Applying or cancelling a conflict edit returns to the original command with its recorded keys intact. Provably exclusive editor contexts may still share a shortcut; existing bindings are never replaced automatically.

Each row's **More actions** menu contains **Unbind** and **Reset shortcut**. Unbinding leaves other ways to run the command available. Resetting an individual command requires resolving conflicting custom bindings first. **Reset all** restores every command after confirmation. Status labels distinguish Default, Custom, Unassigned and Unbound.

System-reserved shortcuts and unmodified text-entry keys cannot be assigned as the first stroke. Editor shortcuts apply within the editor; ordinary settings/search fields retain their text editing behavior. Individual keycaps have full-name tooltips, and toolbar hints reflect the current bindings.

## Editor preferences

- **Line numbers:** on (default), relative or off.
- **Minimap:** off by default.
- **Whitespace:** selection (default), none or all.
- **Format on paste:** on by default.

These options apply without recreating the editor or clearing undo history. Existing font size, word wrap, indentation, language, theme and layout settings remain available.

## Saving

**Auto save** and **Format on save** are both off by default.

Auto save can run after typing stops, or when leaving the editor. The delay can be 500, 1,000 (default), 2,000 or 5,000 milliseconds. Leaving the editor includes switching files, opening another panel or switching away from the application. Using the editor's find or completion widgets does not count as leaving it.

Auto save only saves modified, open files and does not format them. When enabled, Format on save applies to manual Save, Save all and the saves before building/running. It uses the current indentation size and the existing Basic Plus or JSON formatter; unsupported file types are saved unchanged. Formatting changes in open files can be undone. A formatting or save failure stops the requested save/build and preserves unsaved work.

Source writes and recovery drafts are serialized. Input typed during a write stays unsaved until that newer content reaches disk. Project switches and file moves/deletions wait for pending writes; compilation still saves recovered drafts even if their files are not open. Failed automatic saves are reported rather than retried in a loop; edit the file or save manually to try again. Existing draft recovery and the unsaved-tab confirmation remain available.
