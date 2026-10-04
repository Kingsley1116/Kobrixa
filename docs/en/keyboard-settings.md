# Keyboard shortcuts and settings

Open Settings from the gear button or **Command+,** on macOS / **Ctrl+,** on Windows and Linux. General preferences take effect immediately and are saved on this computer. A save-error message for general preferences means they still apply for this session; use **Retry saving** to persist them. Device parameters and update preferences apply only after saving succeeds.

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

The list shows all IDE and bundled Monaco editor commands, including unassigned commands. Every command has an English and Traditional Chinese name and operation description. Descriptions appear below command names and in the shortcut editor, explaining the effect and any required command arguments or language providers. Expand a command name to see its English name, ID, applicability conditions and default shortcuts. IDE commands appear first; editor commands are sorted by their names in the current language.

Search supports multiple keywords across Chinese and English names and descriptions, command IDs and keys. Modifier aliases include `Cmd/Command/⌘`, `Ctrl/Control`, `Option/Alt/⌥`, `Shift/⇧` and platform-specific `Mod`. Combine searches with source (IDE or Editor) and status (Modified or Unassigned) filters. Unassigned includes intentionally unbound commands. Changing the interface language preserves your search and shortcut editing state.

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

## Search and reset settings

All settings groups general, editor, saving, layout, EV3 and update preferences. Search combines Chinese and English names, descriptions, setting IDs and multiple keywords. Searching selects all categories; select a category to narrow the results. Modified only compares the saved preference with its default, so a system theme's current appearance does not change its modified status.

Each setting shows its default; modified settings can be reset individually. If resetting removes a filtered row, focus returns to search. Dependent settings remain searchable with an explanation of their requirements, such as selecting After delay before adjusting the auto-save delay. Keyboard shortcuts keep their own search and reset interface.

## Appearance and advanced editor preferences

Follow system tracks system light/dark appearance immediately. The top theme button switches the effective appearance and saves an explicit light or dark choice. The initial default remains dark.

Line height offers compact (1.4×), standard (the existing font size × 25/16), and relaxed (1.8×). Choose a line, block or underline cursor and independently toggle blinking. Current-line highlighting can be off, cover the code line, or include the gutter.

Bracket colors, bracket/indentation guides, folding, sticky scope lines (up to three), automatic bracket/quote closing, automatic suggestions, hover information and parameter hints default to on. Smooth scrolling and scrolling beyond the last line default to off. Disabling automatic suggestions still allows manual completion.

Reduced motion temporarily disables smooth scrolling and cursor blinking while retaining their preferences. Editor changes apply immediately, preserving contents, cursor and undo history.

## EV3 and execution preferences

Connection method initially defaults to USB and then remembers USB/Wi-Fi selection. Changing this preference does not interrupt an existing connection. Remember Wi-Fi address defaults to off; enabling it stores the last successful manually entered connection address. Disabling it clears the saved address while retaining current input.

Build diagnostics can open automatically on errors (default), on errors or warnings, or never. Opening activity on device-operation failure defaults to on. Required connection prompts always remain visible.

| Device parameter             | Choices                         | Default                                  |
| ---------------------------- | ------------------------------- | ---------------------------------------- |
| USB automatic reconnect      | On/off                          | On                                       |
| USB retry interval           | Backoff, fixed 1/2/5/10 seconds | Backoff: 1, 2, then 5 seconds repeatedly |
| USB attempt limit            | 3/5/10 attempts, unlimited      | Unlimited                                |
| Wi-Fi TCP connection timeout | 3/5/10/30 seconds               | 5 seconds                                |
| Wi-Fi handshake timeout      | 1/3/5/10 seconds                | 3 seconds                                |

The first reconnect attempt is immediate and counts toward the limit. Exhaustion stops retries and prompts a manual connection. Disabling automatic reconnect immediately cancels waiting or in-progress recovery. Interval and limit changes apply to the next recovery; Wi-Fi timeouts apply to the next connection. USB continues to identify devices by serial number and verify uploaded contents. Reconnecting never automatically runs a program.

General preferences take effect immediately and are stored on this computer. The main process saves device parameters before applying them; failed writes retain the previous values and can be retried. Settings are shared by all local projects.
