# Stage 3E：EV3 設備 UI 遷移設計草案

日期：2026-10-24；分支 `feat/plugin-3e`，基準 `a31da12`。供審查，未實作、未凍結新增契約、未宣告驗收完成。

## 1. 範圍與依據

權威為 [Stage 3 umbrella](2026-10-17-plugin-system-stage-3-design.md) §1、§3.2、§4.7、§6–9；實作安排見[計畫](../plans/2026-10-24-plugin-system-3e-device-ui.md)。shared stage3 此基準只有 3A；不能據此認定 B1/B2 能力不存在，也不能將 sibling 成果視為已整合。

現況參照 B2 `871e581`、3C `4c86f0a`、3D `f822f3c`；B2 未提交的 test-only candidates 不作證據。3D 的 sensor-lab design／plan 是 D1 待審提案；純 cursor 修正不改本設計的 UI 契約依賴。

完整目標是 device-ev3 公開連線、探索、監測、mode、設定與 recovery UI；main builtin provider 維持可信任 in-process。remote-files、build/deploy/run 與 execution 摘要保留 core 例外，操作仍經同一 broker。motor 與 Lab 分別由 3C／3D 完整退出私有掛載，不能藉 3E 縮減其範圍。

重用 B2 persistence/import/coordinator、B1 launcher/renderer/lifecycle、3A broker/provider、3C public-process 接線及 3D 已審模型／v2；不另建 broker、settings store、sampler、profile lock 或跨功能 service bus。

## 2. 現況與架構缺口

| 已核對來源 | 現況與應補邊界 |
| --- | --- |
| [device-panel](../../../apps/desktop/src/renderer/device/device-panel.tsx)、[execution controller](../../../apps/desktop/src/renderer/execution/execution.ts) | connection 與 build/deploy/version/pending-run 混合；後者拆成相鄰 core 區，feature 不接 `ExecutionState`。 |
| [monitor-panel](../../../apps/desktop/src/renderer/device/monitor-panel.tsx)、[monitor-controller](../../../apps/desktop/src/renderer/device/monitor-controller.ts) | 私有 monitor DTO、mode cache 與 motor/Lab composition；改 public catalog/frame，保留 freshness、busy、unknown 與 read-only 語意。 |
| [device-settings](../../../apps/desktop/src/renderer/settings/device-settings.ts)、[device-preferences](../../../apps/desktop/src/shared/device-preferences.ts) | 六偏好現在走私有 get/set；B2 已有通用立即 CAS 表單，尚需實際 resource/import/backend bridge。 |
| [builtin factory](../../../apps/desktop/src/main/plugins/builtin.ts)、[manager](../../../packages/plugin-runtime/src/manager.ts) | factory 依摘要 `status === enabled` 同步；B2 manager 會將 supervisor failed 投影成 source failed。新增 UI process 後，不能因 UI crash 撤 provider。 |
| [device schemas](../../../packages/plugin-protocol/src/device-methods.ts)、[types](../../../packages/plugin-protocol/src/device-types.ts) | list/discover/connect/session/read/subscribe/inputModes 已有；USB retry/recovery notice 與取消的完整公開投影尚缺。 |
| [UI resource](../../../packages/plugin-protocol/src/ui-resource.ts) | v1 已有可信 core disconnect/openRecovery；select options 靜態。動態 candidates/modes 依 D1 的 v2 list/table，不塞 JSON 字串。 |

所有新增 host port 名稱只作責任描述，正式型別／exports 由原 owner 定案。3E 不自行創造已發布的 API 1.8；完成版 manifest 為 `^1.8.0`，沿用 3D 唯一版本批次、不另升 minor。

### 2.1 同一 source，兩種生命週期

唯一身分是 `builtin:kobrixa.device-ev3`／plugin ID `kobrixa.device-ev3`。host allowlist 同時組合 main provider factory 與 shipped Node UI entry；process 只能 consume public SDK，不能 register provider。第三方 provider declaration 包括空陣列仍拒絕，compiler `kobrixa.ev3` 的必要政策不變。

H-R 提供正式 host-only source eligibility／revision port；H-K factory sync 消費它，依 source enabled、safe-mode suppression、manifest/provider validity 與 replacement 判斷，不依 process running、UI visibility 或摘要 failed。程序錯誤與 provider 錯誤分開呈現；同步需冪等、序列化，舊 unregister 不得移除新 provider generation。

source disable 先 gate 新工作，經 coordinator stop/readback、end/drain/save，再撤 provider 與 UI；失敗保留 blocker／cleanup handle。UI crash 只 retire 該 process 的 operations/subscriptions/resources，不停用健康 provider 或其他 consumers；不得用重啟 UI 恢復操作。

### 2.2 正式依賴與 blockers

| 項目 | Owner／完成門檻 |
| --- | --- |
| source eligibility 與 provider teardown 次序 | H-R（B1 runtime）＋H-D/3A；補 source 與 process 分離 port、crash/disable/replacement fixtures，不能以摘要推斷。 |
| authoritative preferences 讀取與 commit 通知 | B2/H-D 定義 host-only namespace port；給 provider/backend 的 reader 不假冒 plugin principal、不借 renderer form binding、不呼叫 private RPC。 |
| Wi-Fi 記住位址的 atomic dependent-field 更新 | B2/H-P/H-D/H-V，**E1 dependent**：一般 contributed form 只提交單欄，現有 schema 沒有相依欄位規則。必須凍結公開可查的相依欄位語意／host 正規化契約，讓 update 與 reset 將 remember=false 及空 lastWifiAddress 放在同一筆 CAS；不可用 commit 後 watcher 清除。 |
| recovery 公開狀態與取消 | 3A/H-P＋B1/H-V，**D1 dependent**：界定 bounded retry 狀態、notice、host-issued recovery identity、可信取消 action 與 stale rejection；現行 connected/quarantined snapshot 不足，不捏造方法名稱。 |
| candidates/modes 的 revision 選取 | 3D/H-P/H-V，**D1 dependent**：共用 v2 list/table dataset、row ID/revision、失效/錯誤與雙 SDK；不另造 device-specific table。 |
| monitor source semantics | 3A/H-P 與 3D D1 共用 EV3 identity vocabulary；核對 ready/empty/unsupported/error、mode label、battery/program 等公開表達，缺失由 owner 補 fixture，不匯入私有 catalog。 |
| packaging resource inventory | H-K 與 B2/3D：目前 C launcher 的 JSON 宣告枚舉只接受 v1 且漏 settings；必須共用修正 settings/v2 inventory，才可封裝完整 3E。 |

D1 不成立時可準備 parity fixtures，不能發布半套 UI、刪 legacy 或宣稱相依能力 available。公共 limits 的變更一律回 owner 審查並同步 umbrella／版本規則。

## 3. 行為等價表

| 現有行為 | 新落點與必保留結果 |
| --- | --- |
| USB/Wi-Fi 切換、discover、候選選擇 | 公開 `devices.discover({ providerId }, signal?)`，最多 32 candidates；v2 list/table 依 transport 篩選，empty/error/searching 分開，選取綁 discovery revision，失效後重搜。 |
| Wi-Fi 直接位址、連線錯誤 | 公開 candidate 或 wifi-address target；trim 後依 address schema 驗證，保留 draft/error/retry。UI 不讀 raw HID、native metadata、本機路徑或 transport descriptor。 |
| 既有連線重用／USB 自動重連 | trusted provider/core 依 committed prefs 與現行 recovery policy 決定；開啟 panel 只讀 catalog，不 discover/connect，不重送 run/upload/motion/recording。重連建立新 session。 |
| recovery waiting/connecting、取消、retry-exhausted/manual-required | D1 公開 bounded 投影及可信取消；失敗保留 recovery/error，晚到 restored 不得覆寫取消或新 session；部署是否仍有效由 core 驗證、顯示 upload-required。 |
| pending-run 等待與取消 | 留 core execution 相鄰區；明確先前 Run 的短期意圖由 core 管理，連線後重驗 workspace/authority/cancel。UI open/reload/re-enable 不創造或回復 pending Run。 |
| Disconnect | v1 core action 的 data-session reference；host quiesce→stop/readback＋end/drain/save→disconnect，顯示進度。feature 不以 `devices.disconnect` 強斷其他 owner；該 API 仍回 busy。 |
| battery 百分比／電壓、program status | public channel/frame 與 program stopped/running/unknown；缺值顯示 unknown，不能以 null 當 0。core 全域 battery demand 與 UI 共用 broker sampler。 |
| 四 input／四 output、值／單位／年齡 | catalog＋read/telemetry，最多 38 channels；保留 ready/empty/unsupported/error、busy/waiting/paused、null gaps；foreground file/program 期間不得將舊值標 live。 |
| input mode query/set | v2 rows 選 mode ID，帶當前 session/source revision；fresh、idle、ready、可切換且無 recording pin 才啟用。host admission 及 consequential step 再驗 authority/locks。 |
| fresh／read-only | 依 public status/age（fresh 2.5 秒）與可信 authority；失權仍可 read/stop，禁止寫入。UI disabled 不是安全邊界。 |
| 六項偏好／單欄 reset／失敗重試 | B2 contributed settings 逐欄立即 CAS，無 Apply；成功才發布新值，失敗 draft/error/retry 保留。 |
| build/deploy/version、remote-files | core execution summary／原 remote-files UI；共用 legacy broker adapter、authority/cancel，feature 不收 private DTO／path，不搬成假公開 UI。 |

pane 為 Plugin tools 內 device-ev3 sibling tab；連線／監測可在同一公開 panel 分區，設定用通用 contributed settings。導覽由 host 管理，不互相呼叫 motor/Lab 私有 controller。

remote control authority 是本機 host 綁定的協作控制權；不代表 guest 可以存取遠端主機的實體設備。文字保留「本機 EV3」範圍，未同步／unbound 一律不准寫。

## 4. 偏好、一次性匯入與 backend

六項 canonical 值與選項沿用 shared defaults，resource schemaVersion 1；這是 host-owned namespace，feature 不擁有另一份持久化真相。

| key | default／合法值 |
| --- | --- |
| skipUnchangedAssets | true／boolean；core deploy 消費 |
| usbAutoReconnect | true／boolean |
| usbRetryInterval | backoff／backoff、1000、2000、5000、10000 ms |
| usbRetryLimit | unlimited／unlimited、3、5、10 |
| wifiConnectTimeout | 5000／3000、5000、10000、30000 ms |
| wifiHandshakeTimeout | 3000／1000、3000、5000、10000 ms |

renderer 連線偏好另為同 namespace 的 UI 欄位：connectionMode、rememberWifiAddress、lastWifiAddress；不混入上述六項 provider policy。保留原預設、remember=false 清空地址、成功明確連線才記住地址，不保存 candidate/session handles。 這個跨欄原子性尚非既有表單能力；E1 完成前不能宣稱直接套用通用表單已滿足。B2/H-D 持有 `settings-service.ts` 的必要 mutation 接線及直接測試，H-P/H-V 同步公開 resource 語意與表單呈現；所有 SDK update、reset 和表單寫入均須同樣驗證，不能只在 feature process 正規化。

B2 host descriptor 分別讀 `device-settings.json` 及 allowlist `kobrixa.connectionMode`、`kobrixa.rememberWifiAddress`、`kobrixa.lastWifiAddress`。renderer snapshot 用既有 challenge nonce／window scope；不向 process 暴露 localStorage、路徑或任意 import RPC。

H-D 使用 B2 LegacyWriterBarrier 凍結舊六項與 renderer 三項 writers，等待在途寫入；planned journal→validated mapping→target CAS/receipt→complete marker 後切換。兩來源組成完整 snapshot 的次序／合併須由 B2 owner 固定，不能兩個完整 replacement 互相蓋值；已存在目的 revision 不覆寫，衝突 blocked。originals、digest、receipt 保留，重入不重複，reset 後不復活舊值。

合法缺項可用 schema default 補齊並記錄；ENOENT 與 corrupt/permission/I/O 必須分開。損壞、未知版本、錯誤型別或無法讀取不默默恢復預設；blocked 供 core 修復／重試。當前 legacy loader 的 catch-all defaults 不可沿用至新 namespace。

complete barrier **之前**，可信 core 可讀取已驗證且標明 legacy 的舊偏好維持既有操作；進入 barrier 後唯讀且不雙寫。complete **之後**只有 authoritative namespace，讀取錯誤不得回落 legacy/default。首次確認無資料才使用 defaults；publish unknown 先 reconcile，不能顯示已套用或重做另一筆寫入。

B2/H-D host reader 以 source/schema/revision/import disposition 回傳完整 snapshot，commit 後通知 provider/backend 並消除 missed-watch race；讀取不需啟 UI process。初始化未取得可靠 policy 時擋新可選 I/O；現有安全 stop/cleanup 不依它成功。後續失敗保留最後 committed 值與明確問題，禁止新連線／重試採用猜測值。

source disabled/safe 時不載 optional resources/mapper、不做 optional namespace I/O、不啟 provider/UI；core recovery 可讀自己的 journal/checkpoint，不以讀設定為由自動啟用 source。一般 enabled 且 UI 未開時，可安全讀 host namespace、註冊 provider。偏好變更只影響後續合法步驟，不延長進行中 deadline、不授予重播權。

逐欄有效變更以 expectedRevision atomic CAS；conflict 重讀 committed snapshot，保留該欄 draft，讓使用者重試而非覆蓋別欄。reset 同路徑；disabled/retired generation 的在途 commit 不可發布。B2 通用表單承擔 failed draft，feature 也以公開 settings read/watch 證明真 consumer。

## 5. Lifetime、stale 與故障

| 事件 | device UI／provider／其他功能 |
| --- | --- |
| panel hide/close | 移除 view subscriptions、取消未完成 view 命令；不 disable provider、不斷線、不結束他人錄製。重開只取新 snapshot。 |
| UI process crash | 撤自身 owner；provider 存續，其他健康 motor/Lab 依各自生命週期；明確重開才建新 bindings。 |
| provider disable/loss/replacement | gate、stop/readback、end/save；UI unavailable 並清舊選取/mode cache。健康 consumers 不永久停用、不 retire execution generation，恢復不續錄。 |
| renderer crash/window destroyed | host retire 受影響 owner、bounded drain 後 process teardown；provider 不因 UI crash 等同 disabled，安全工作由 core 處理。 |
| suspend/wake | host stop/end/save，wake 不恢復 motion/recording/pending-run；僅解除已釐清 gate。 |
| safe/all-off/cold start | optional executable/data-only contributions/import/provider 均受抑制；core 管理、fault、checkpoint、停止未確認畫面仍可用。 |
| second instance | 既有 single-instance lock 聚焦原視窗後退出；不啟動第二 provider/process、不寫 profile。 |
| shutdown/update | 沿 B1/B2 coordinator，stop/save/journal 失敗阻擋正常完成；timeout 不等於安全或自動 force exit。 |

所有 async 結果核對 source eligibility revision、execution/resource generation、process epoch、panel instance、session ID/sourceRevision；只接受遞增 sequence。session/provider loss 清空 actionable handles；可保留標記過期的最後值，不可授權 mode write。event gap 重取 snapshot，late discover/connect/mode/patch 不復活舊 session。

Disconnect／suspend 的 reservation end 走既有 onEnded→endReservation→drain，不能新增另一個 finalizer。device stop 15 秒＋journal 5 秒與 storage 10 秒並行，再 manager 4 秒，外層 25 秒；coordinator rejection、save retryable/checkpoint-only/uncertain、stop unconfirmed 均留 core blocker。

headless 或 cold safe 無 session 時只顯示未確認與可行復原，不偷偷啟 provider/連線來「確認停止」。有匹配的現有 session／有期限 cleanup handle 才可 stop；不得停止不相關設備。optional-only crash 不新增全域 safe lock；renderer unresponsive／第三方風險沿既有規則。

## 6. 封裝與完成界線

預定 `plugins/device-ev3/src/main.ts` 為公開 SDK process entry；manifest runtime node/main.cjs、API `^1.8.0`、panel v2、settings v1，權限限 devices.read/connect/control、ui.panels、settings.read/write。control 僅供 mode，不攜帶 raw transport/helper/native package。

沿既有 `vite.plugin-device.config.ts`／shared plugin build 與 launcher，installed leaf `device-ev3/` 含 main.cjs、kobrixa-plugin.json、ui/panel.json、settings/preferences.json、resource-index.json；SDK 打入 bundle。index/hash/path containment 與既有 32 files／16 KiB index／16 MiB bundle limits 不變；遺失／損壞明示 unavailable，無 checkout、外部 Node、cwd 或 symlink fallback。

UI process 的 source graph、bundle metadata/content、公開 RPC trace 三證須無 desktop-private imports、React/Electron API、私有 DTO/IPC、direct fs/network/USB。provider native dependencies 只在 main 安裝布局驗證，不能以 UI bundle 啟動成功代替。

完整 replacement 的 public transport、import/restart、installed 與 parity 證據到位後才撤舊 mount/consumer；逐符號核對仍服務 core 的 device IPC/preload/DTO，不刪整個 namespace。MANUAL 未完成列待驗，不能核銷 umbrella 例外或 Stage 3 gate。
