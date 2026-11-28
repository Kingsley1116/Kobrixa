# Stage 3C：有界實作計畫（controller 已審閱；authoring 可執行，真實整合 gates 保留）

## Current disposition — 2026-11-11

Motor is integrated as the shipped public plugin. Its private controls/controller/service, feature IPC/preload and old mount are removed; the EV3 provider motion engine/helper and core broker/journal/stop remain. The historical [77-case native/installed receipt](../evidence/2026-10-24-3c-native-installed/README.md), [Linux isolation receipt](../evidence/2026-10-24-3c-linux-installed/README.md), and later [post-retirement product audit](../evidence/2026-10-30-3d-retirement/README.md) describe their own artifacts. The last record checks absence of both private Motor/Lab routes and exercises Motor in the unchanged whole product; its Lab cases are separate acceptance hosts.

T1–T3 implementation and motor runtime retirement are present; T4/T6 **final-candidate** native/regression/package acceptance remains open. Earlier “not executed” and ownership sections below describe their original planning dates, not an instruction to reimplement retirement. Run `node tests/desktop/motor-test-public-run.mjs --all` (all 77 cases) plus `node --test tests/desktop/motor-test-boundaries.test.mjs`, or `node tests/desktop/stage-3-closeout-run.mjs motor --run`. General desktop smoke's feature handoff is not that run; installed source denial requires the explicit isolated gate. S3-13/S3-15 and H1/H5/H6 are **NOT RUN**. No final W20 artifact is accepted; see the [S3 ledger](../specs/2026-10-17-plugin-system-stage-3-design.md#s3-current-ledger).

## Original implementation plan / historical requirements

日期：2026-10-23。依 [3C 子規格](../specs/2026-10-23-plugin-system-3c-public-motor-design.md) 與 approved umbrella。controller 已依 umbrella 核准 T1–T3 authoring；以下驗收尚未執行，不代表產品或硬體通過。C-G1 由 B1 owner 同步實作，實際整合與 legacy 移除仍依 gates。

## 1. 開工／整合 gate

- A accepted／user-merged `e817e59`；B1 API 1.6／K160 當前實作可供 authoring，**P160 pending**。B2 API 1.7 尚未整合；3C 不等 B2、不使用 B2 API、不升版。
- controller 先審本兩文件與 C-G1：B1 owner 核准最小 generic volatile-draft amendment、完成對應測試後，才可宣稱 close/reopen parity。該修正另由 B1 owner 持有，不能塞進 feature 私有 API。
- T1–T3 可先做 pure／mock-driven authoring；T4/T5 可先寫案例／文件。T6 真實 composition／payload activation／legacy removal 僅在 reviewed P160 gate 後執行；C-G1 未解不得通過完整 parity／移除 gate。
- controller 記實際基底 SHA、review 結果、commands／artifact hashes；不把 K160／P160 符號當 commit SHA，不把 B1 native fixture 證據挪作 3C product proof。
- 分為五個互斥 authoring slices 加一個 integration slice；controller 本地按依賴套用、審閱並分段 commit，無 shared merges、refs 操作或 Co-Authored-By。此計畫不要求啟動 agents。

## 2. Write sets（封閉清單）

以下路徑是未來實作的允許集；未列路徑不自動獲准。generated artifacts 寫入既有 build output／臨時 evidence directory，不手改 bundle／index。若需額外檔案，先由 controller 調整此表。

| slice                     | 唯一 write set                                                                                                                                                                                                                                                         | 交付／界線                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 pure model             | `plugins/motor-test/src/model.ts`、`plugins/motor-test/src/model.test.ts`、`plugins/motor-test/vitest.config.ts`、`plugins/motor-test/tsconfig.json`                                                                                                                   | 參數／defaults／DTO mapping／progress／結果文案模型；不 import desktop、無 I/O                                                               |
| T2 resources              | `plugins/motor-test/kobrixa-plugin.json`、`plugins/motor-test/panel.json`、`plugins/motor-test/status.json`、`plugins/motor-test/resources.test.ts`                                                                                                                    | API ^1.6、UI v1、25 fields 四群組、bilingual、公開 commands／core Stop；不改 renderer                                                        |
| T3 public process         | `plugins/motor-test/src/main.ts`、`plugins/motor-test/src/feature.ts`、`plugins/motor-test/src/feature.test.ts`                                                                                                                                                        | SDK ready／commands／selection／prepare-once-start-once／query／stop／observation cleanup；不改 SDK／protocol                                |
| T4 acceptance authoring   | `tests/desktop/motor-test-public.test.mjs`、`tests/desktop/motor-test-public-main.ts`、`tests/desktop/motor-test-public-renderer.tsx`、`tests/desktop/motor-test-public-run.mjs`、`tests/desktop/motor-test-boundaries.test.mjs`、`tests/desktop/motor-test-smoke.mjs` | 真實 SDK＋host compose、generic renderer native runner、依賴 audit、既有 smoke replacement；test-only provider 可控故障，不做 feature facade |
| T5 docs／manual           | `docs/en/motor-test.md`、`docs/zh-TW/motor-test.md`、`tests/hardware/motor-test.md`                                                                                                                                                                                    | 插件工具 pane、選取／開關／停止／safe mode／不重播；人工清單與 evidence 欄位，無虛構結果                                                     |
| T6 controller integration | 見下列閉合集                                                                                                                                                                                                                                                           | packaging／composition、實際 acceptance、parity 後 legacy removal、證據索引；不碰 B2／3D／3E feature                                         |

T6 閉合 write set：

- 建置／來源註冊：`vitest.config.ts`、`apps/desktop/packaging.ts`、`apps/desktop/src/main/plugins/builtin.ts`、`apps/desktop/src/main/plugins/builtin.test.ts`、`apps/desktop/src/main/plugins/builtin-launch.test.ts`、`apps/desktop/src/main/packaging.test.ts`。
- 既有 installed tests 改驗真實產品，處理 fixture identity collision：`tests/desktop/builtin-process-installed.mjs`、`tests/desktop/builtin-process-packaging.test.mjs`、`tools/release/desktop-packaging.test.mjs`。不擴 production launch allowlist、不讓 fixture 覆蓋 motor。
- renderer 撤線／相鄰回歸：`apps/desktop/src/renderer/app.tsx`、`apps/desktop/src/renderer/device/monitor-panel.tsx`、`apps/desktop/src/renderer/device/monitor-panel.test.ts`、`apps/desktop/src/renderer/device/motor-test-controls.tsx`、`apps/desktop/src/renderer/device/motor-test-controller.ts`、其同名 `.test.ts`。
- legacy host adapter 撤線／相鄰回歸：`apps/desktop/src/main/index.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/shared/api.ts`、`apps/desktop/src/shared/motor-test.ts`、`apps/desktop/src/main/device/motor-test-service.ts`、`motor-test-service.test.ts`、`motor-test-ipc.test.ts`（後二者同目錄）、`apps/desktop/src/main/collab/device-control.ts`、`device-control.test.ts`（同目錄）、`apps/desktop/src/main/updates/service.ts`、`apps/desktop/src/main/updates/updates.test.ts`。
- smoke composition：`tests/desktop/run-smoke.mjs`；closeout docs：`docs/superpowers/specs/2026-10-17-plugin-system-stage-3-design.md`（僅 §8 motor ledger／證據連結）、`docs/superpowers/plans/2026-10-23-plugin-system-3c-acceptance.md`、`docs/superpowers/evidence/2026-10-23-3c-motor/`。

B1 C-G1 owner 的預期 amendment set（獨立 gate，非 T1–T6 默許修改）：`docs/superpowers/specs/2026-10-17-plugin-system-3b1-declarative-ui-design.md` §6；`apps/desktop/src/renderer/plugin-ui/{bootstrap,state-store}.ts` 與同名 tests。先確認 generic cache 的 key／容量／清除／close 語意，必要 host-side 檔案由該 owner 另列。不得改 `ui/patch` 或增加 wire。

## 3. T1：純模型與 parity fixtures

- 明定四 port 各自 defaults、selected session／source identity、active operation 和 UI presentation 分離；正式型別從 public protocol 匯入。
- form 依 mode 驗證空值、非 finite、小數／整數、上下界；seconds 轉整數 ms；只輸出該 mode 允許的 MotionSpec 欄位。
- 結果顯示 phase／stage、movement／dispatch／confirmation；null 不變 0、timeout 不代表 confirmed stop；progress clamp，brake escalation 不退回 coast。
- tests：power 0/1/100/101、seconds 0.099/0.1/5/5.001 與 rounding、degrees 0/1/3600/3601／小數、非作用欄位 invalid、三模式 DTO strict parse、unknown angle、各終態與 confirmation 組合。
- 驗證（未執行）：`pnpm exec vitest run --config plugins/motor-test/vitest.config.ts src/model.test.ts`。

## 4. T2：manifest／panel／status

- 按 spec 固定 filenames／contribution IDs／permissions／requires／onPanel activation；明確選取唯一 session＋A–D port，catalog 檢查 actuator，不靠 dynamic choices。
- 四組各六欄＋port＝25 fields；條件深度／總 nodes／bytes 留在 UI v1 上限。mode／port 切換保存 draft；Stop core action 永遠不被 invalid form 擋住。
- status 固定 tone、bounded localized data text，無 chart／dialog／自訂 React。雙語 labels／help／error／unavailable；320 px／125% 排版由真實 renderer 在 T4/T6 驗。
- tests：正式 manifest/resource validator、所有 reference／command arguments／field schema 對齊、fields 正好一個 input、mode 遮蔽、required、UTF-8 byte budgets、初始 unavailable、核心 Stop 入口。
- 驗證（未執行）：`pnpm exec vitest run --config plugins/motor-test/vitest.config.ts resources.test.ts`。

## 5. T3：公開 SDK 程序

- `main.ts` 僅 `runPlugin`；`feature.ts` 綁 `PluginContext`。ready 不 connect／enable／motion，先 snapshots 後 bounded subscriptions，不等待硬體阻塞 initialize budget。
- 明確選取 session 時重新驗 catalog；每次 start 解析最新 actuator，檢查 binding/context/scope；jog 使用原 gesture。active operation 保存原 spec 以計 progress，draft 仍由 host 管。
- `prepare` 只一次，儲存 ID後 start 只一次；cancel pending prepare、lost start、late replies 全走原 operation stop/query。command handler 不阻塞至整段 motion 結束；觀察另有 bounded lifetime。
- 結束／disable 清 subscriptions／timers；stale patch 重新讀 presentation，不能重試 side effects；停止錯誤保留 uncertainty，host/core 有最終安全責任。
- tests（mock）：duplicate begin、invalid form、不完整 context、prepare pending cancel／late ID、start lost reply query same ID、query lost／stale revision、stop escalation、catalog replacement、gap resync、locale、unsubscribe、deactivate。斷言無第二次 prepare/start、無自動 connect。
- 驗證（未執行）：`pnpm exec vitest run --config plugins/motor-test/vitest.config.ts src/feature.test.ts`；mock PASS 只代表邏輯，不能記 native PASS。

## 6. T4：真實公開路徑、renderer 與 smoke replacement

- compose 必須載入 **真實 motor manifest/resources/entry＋實際 JS SDK**，經 MessagePort／public routers、broker 和 test provider；測三模式、結果／錯誤、read-only viewer、busy recording／program、source／provider loss。不可用一個假的 MotorApi 代替 SDK。
- renderer runner 使用現有 `PluginPanelHost/PluginStatusHost/RendererSession`、表單與 intent bridge；本地 test renderer 只組通用 host，不加 motor callbacks。以真實 pointer/key events 驗 hold/release/cancel、Space/Enter、repeat 不續命、Stop invalid form 仍可用。
- matrix：prepare/start/arm/pulse await 邊界前後，分別注入 hide、close、blur、authority loss、renderer crash/freeze、plugin kill；涵蓋 start held 未回覆先 hide／stop、lost start query 同 ID、late reply 不復活、withheld readback 進 unconfirmed。明確量測 revoke→最後 write／stop result，有限 pulse 不超既有 bounds。
- 其他 lifecycle：motor disable/re-enable 與 provider toggle 獨立且持久保存、safe mode cold suppression／core recovery、suspend/wake 不重播、second launch 無新 operation、normal quit blocker／force exit uncertainty、斷線再重連不續作。
- C-G1 測試：在 A/B port 各輸入不同參數與 invalid raw，切 port／hide／close-reopen；同 workbench draft 留存、舊 scope／operation 不恢復；resource generation／renderer retirement 等清除條件符合 amendment。
- `motor-test-smoke.mjs` 保留三模式、defaults／validation／per-port、progress、bilingual/narrow layout 涵蓋；移除 private test-service injection。舊「切 pane timed 繼續」改為 host 要求 stop、無新 motion、結果 confirmed 或明確 unconfirmed；增加 start 未回覆前 hide，不能只刪舊案例。
- boundary test 同時檢 source imports、Vite transitive module metadata／bundle、RPC allowlist trace；加入禁止 desktop facade／dynamic import／external／私有字串 channel 的負例。SDK parentPort 是唯一既有 transport，不把 test host 的 dependencies 算進 feature bundle。
- 驗證（未執行）：`node --test tests/desktop/motor-test-public.test.mjs tests/desktop/motor-test-boundaries.test.mjs`；`node tests/desktop/motor-test-public-run.mjs --all`（native Electron）；`pnpm test:desktop:smoke`（實際執行已替換 checkMotorTests）。runner 未完成或 skip 即 pending。

## 7. T5：文件與人工 gate

- 更新 en／zh-TW 使用流程：插件工具 tab、手動 session／actuator selection、未連線／provider unavailable、三模式 limits、hide/close/blur 都 stop、error／uncertainty／core recovery、獨立開關／safe mode，不自動 connect／續作。
- `tests/hardware/motor-test.md` 追加 public-route USB／Wi-Fi、三模式、負載、release／cancel／hide／close／window loss、失權、disable／kill、拔線／重連；區分 stop request、host readback、肉眼實際停止，記 firmware／OS／architecture／app SHA/hash。
- 人工 gates **未執行**：S3-13 實體 EV3；相關 S3-15 乾淨機器安裝、無 checkout／使用者 Node、en／zh-TW、明暗／320 px／125%、keyboard/focus、safe-mode recovery。未測平台逐項標 pending，不能由 software fixture 代簽。
- 文件檢查只核對行為／命令／路徑與實際結果；不預填 PASS。全 Stage 3 architecture／Lab／device closeout 仍歸 3D／3E。

## 8. T6：controller 序列整合與 legacy removal

1. 核對 reviewed P160 gate、C-G1 amendment evidence、最新 source／合約，整合 T1–T5；以本地分段 commits 保持 write sets 可審，任何 contract drift 退回所屬 owner。
2. 在 `DELIVERED_BUILTIN_PROCESS_BUILDS` 登記既定 motor input/config/slug；optional builtin 使用現有 validated launch descriptor 註冊，預設啟用但 lazy activation，不自啟 motion。fixture collision tests 改驗真實 motor payload。
3. root Vitest 加 motor project；沿既有 Forge／release shared build registry，不複製另一套 pipeline。確認輸出 `main.cjs`、manifest、panel/status JSON、index bytes/digests，SDK 全打包，無 runtime workspace externals。
4. **先保留 legacy 路徑**，通過 T4 product public proof、actual SDK compose、真實 renderer、installed smoke 及 C-G1 drafts parity，再依 caller inventory 撤 mount／controller／feature adapters／private IPC；不建立雙 route 或在公開路徑失敗時 fallback 私有 route。
5. 移除 `app.tsx`／monitor card motor UI/effects；舊 busy/drain 邏輯改依既有 core broker／coordinator 的停止與仲裁，不以 plugin process alive 代表安全。legacy Lab 的真實 persistence／close 保護不得因 B2 未整合被移除。
6. 清 shared/preload/private motor routes 與 obsolete service 接線；若舊 tests 隨 feature 移除，先將 safety 斷言移到 provider／public tests。provider `motion.ts`／helper image、安全 engine、core stop/readback/journal 保留。`rg` 確認 surviving callers 後才刪不用的 UI/controller 檔案。
7. 執行下節檢查，記 before/after artifact identity、完整 commands、exit code、skip／failure、trace／hash；最後才更新 umbrella motor ledger。自動化通過但人工未跑時，只能回報「實作已交付，待人工驗收」。

## 9. 整合驗證清單（均未執行）

| 層次                     | 精確入口／必要觀察                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| feature                  | `pnpm exec vitest run --config plugins/motor-test/vitest.config.ts`；T1–T3 和 resource fixtures                                                                                                                           |
| 現有 public 合約回歸     | `pnpm test:device-broker`、`pnpm test:declarative-ui`；SDK／runtime／desktop affected tests 以 root Vitest 跑實際檔案，不把未列入 project 的 tests 當已跑                                                                 |
| Type／lint               | `pnpm check:desktop`、`pnpm exec tsc -p plugins/motor-test/tsconfig.json --noEmit`；feature files 另由自身 TS 設定檢查，不能只依 desktop tsconfig 排除後宣稱通過                                                          |
| public compose／boundary | `node --test tests/desktop/motor-test-public.test.mjs tests/desktop/motor-test-boundaries.test.mjs`；actual SDK trace、public-only bundle proof                                                                           |
| real renderer native     | `node tests/desktop/motor-test-public-run.mjs --all`；T4 matrix／視窗／key／pointer、停止不確認與 drafts；generic browser/mock renderer 結果分列                                                                          |
| 既有 motor smoke 替換    | `pnpm test:desktop:smoke`；實際跑更新後 checkMotorTests，全部 skip／其他 smoke failure 仍原樣記錄，不能記全套 PASS                                                                                                        |
| release payload          | `node --test tests/desktop/builtin-process-packaging.test.mjs tools/release/desktop-packaging.test.mjs`；沿 shared build path 且不是 fixture motor                                                                        |
| installed product        | `pnpm test:desktop:packaged`；installed runner 載入真實 motor；checkout 不可用、離線、無外部 Node、cwd 非 repo；所有 payload path/hash、toggle/re-enable、quit、missing/tampered resource fail-closed，不 fallback source |
| provider／core 保護      | 受影響的 broker、EV3 motion、core recovery、shutdown／updates、legacy Lab regression；無新並行鎖／無 orphan lease／subscription／process，正常 close 不能隱藏 unconfirmed                                                 |
| MANUAL                   | T5 實體 USB／Wi-Fi 與乾淨安裝 gates；維持 UNRUN，直到有人附具名實測 artifact evidence                                                                                                                                     |

建置沿既有工具執行，不新增 install 流程。若現有 build command 自帶 install 步驟，controller 記錄該既有行為及環境，不能在此文件階段執行；缺環境即標未跑。精確 native invocation flags 依 reviewed P160 harness／新 T4 runner 實際介面固定，不能用 units pass 冒稱 native evidence。

## 10. Review checklist

- [ ] C-G1 有 B1 owning amendment 或明確核准差異；無私有 draft setter／wire 擴張。
- [ ] ^1.6／v1、actual SDK／compose／renderer／installed product 與三重 dependency audit 都有獨立可查證據。
- [ ] start-held-hide、query 原 operation、stop／uncertainty、生命週期矩陣與獨立開關通過；無 motion replay／自動 connect／enable。
- [ ] replacement parity 先通過再移除舊 feature adapters；host/provider safety 與 legacy Lab persistence 保護仍在。
- [ ] 每個測試分清 mock／browser／native／installed／physical；MANUAL 未跑明列，B1／3C 均未冒稱完整 Stage 3。

## 2026-10-24 自動證據進度

- `4c86f0a` 的實際 public/native 77 個情境通過；[macOS native 與 installed 原始證據](../evidence/2026-10-24-3c-native-installed/README.md) 已保留。macOS installed 四情境通過，但該次未限制原始碼讀取。
- `dbccbc2` 的乾淨 Linux arm64 產品建置與四個 installed 情境通過；[Linux 隔離證據](../evidence/2026-10-24-3c-linux-installed/README.md) 記錄每個主程序的來源／依賴讀取拒絕、TCP 拒絕、無外部網路介面及 Chromium sandbox。這補齊該平台的 source-access-denial 證據，沒有改寫舊 macOS 結果。
- `634248b` 修復 Linux ARM64 打包輸出路徑；`dbccbc2` 增加 Linux 隔離驗證。人工硬體／跨平台與介面驗收仍未執行。
- reviewed P160/U12 與 B2/X-T1 的整合關卡、legacy 移除及移除後重新封裝仍待完成；以上局部證據不代表 T6 或 Stage 3 全部完成。

## T6 legacy retirement ownership clarification (2026-10-30)

The C public77-case and Linux installed receipts support implementing the motor-only legacy retirement; final removal/build/native regression remains required. One stopped owner may edit the existing T6 renderer/main/IPC/preload/shared motor paths, plus direct callers `apps/desktop/src/renderer/device/monitor-workspace.tsx`, `monitor-workspace.test.ts`, `apps/desktop/src/renderer/execution/{execution.ts,execution.test.ts}`, `apps/desktop/src/main/ipc.test.ts`, and actual update test paths `apps/desktop/src/main/updates/{updates.test.ts,install-ipc.test.ts,installation.test.ts}` (the earlier service.test.ts name was not an existing file). Transfer useful old assertions into existing `plugins/motor-test/src/{model,feature}.test.ts` and `plugins/motor-test/resources.test.ts` before deleting old test/runtime paths. Do not delete `main/device/motor-test-image.ts` or its test: the EV3 provider still imports that engine helper. Preserve execution/files, monitor/battery, Lab original-writer barrier and main broker/coordinator stop/journal/close/update/authority safety; a stopped plugin is not proof of a stopped motor. Installed E harness files have a different writer and are excluded. No shared-branch merge, hardware claim or completed T6 receipt is authorized by this ownership clarification.

#### Closeout work-package references

These IDs name work scopes, not passing acceptance results.

- **W20**: final regression and delivered-platform evidence.
