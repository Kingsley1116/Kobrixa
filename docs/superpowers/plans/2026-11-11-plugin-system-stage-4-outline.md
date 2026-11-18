# Kobrixa 插件系統 Stage 4 實作綱要

日期：2026-11-11  
狀態：**PROPOSAL／未核准／未實作／未交付**。這是順序與交付邊界綱要，沒有 task-level 實作授權、已完成 checkbox 或虛構測試結果。詳細契約與 owner decisions 見 打包提案（草案：`../specs/2026-11-11-plugin-system-stage-4-packaging-proposal.md`；尚未納入 git 追蹤）。

## 1. Entry gate

Stage 4 實作僅在 **Stage 3 完成並合併至 `feat/plugin-system`** 後開始；主維護者另核准提案與其中 §12 的 decisions。先取得合併 commit、S3-01–16 criterion matrix、R1 Windows journal／R2 memory 決議與實作證據、H1–H6 真實結果、交付平台 artifact hashes、保留例外與 owner。來源為 [Stage 3 current ledger](../specs/2026-10-17-plugin-system-stage-3-design.md#s3-current-ledger)；本次不關閉其 open rows。

本次讀取 HEAD 為 `60a0bde`、同工作樹另有其他工作者變更；指定 `b08336b` CI 與 audit 的 `d228baa` 是不同快照。規劃不代表任何一者是最終通過版本。實作前重讀合併後的程式碼與 ledger，Stage 2 V01–V04 保持原有狀態。

## 2. 提議順序、出口與首批任務

| 階段／粗估                          | 依賴／entry                                    | exit criteria                                                                                                                                    | 首批任務                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4A 格式／信任，L                    | §1 全部成立。                                  | package／runtime metadata、canonical signing vectors、caps、platform matrix、trust bootstrap、storage transaction model 已審查；拒絕負例可執行。 | 決定 owner／精確 write sets；核對 baseline；凍結 ID／range／grants／signature 語意；用代表包驗證大小初案，先做純 validator。                                |
| 4B Python bindings，M               | 4A generator／version contract。               | committed Schema → bindings／wheel deterministic；既有 schema copies／conformance 與新增 typing／drift 全過。                                    | 盤點 `$defs`／keywords，定義 naming／dedup／required-optional-null 映射；保留手寫 cancellation／domain semantics；temp codegen 比對與 sample wheel import。 |
| 4C 交易／復原，XL                   | 4A；Stage 3 persistence、R1／R2 已結案。       | installed identity、single activation head、shadow data／rollback／uninstall、safe mode 與真實 filesystem kill/reopen 通過。                     | 先寫 state-machine／durable frontier 模型；盤點 `dev:` 假設與 source schemas；定義 journal／profile lock／generation 與既有 lifecycle 的 adapter。          |
| 4D runtimes／launch，L              | 4A；4C pins／identity 介面；Python 整合用 4B。 | exact shared Python、per-plugin vendor、離線 runtime／ABI、native stdio admission、child cleanup；每平台 containment 聲明有相應證據。            | 選 runtime 供應者／license／patch policy；製作三平台最小 relocation fixture；驗 launcher env／import roots／簽章／OS 限制 feasibility。                     |
| 4E solver／consent／CLI／channel，L | 純邏輯可在 4A 後；整合依 4B–4D。               | deterministic closure、provider conflict、pack/sign/validate、grants delta、更新／撤銷／offline policy 與實際安裝串接通過。                      | solver 先做 conflict／cycle／API／ABI vectors；core consent 狀態；CLI 使用共用 library；signed metadata rollback／expiry／rotation 負例。                   |
| 4F candidate／release gate，XL      | 4B–4E 完成；freeze 同一 source／artifact。     | 三平台 source-free installed／offline、硬體／人工、供應鏈／撤銷演練、雙語 docs 與逐項 ledger 通過，owner 明確核准一般第三方發布。                | 建固定候選、收 hashes；執行 install→update→crash→recover→rollback→uninstall；執行真實 JS／Python consumer hardware／manual matrix。                         |

S／M／L／XL 是相對工作量，不是時程承諾；詳細 tests、檔案寫入集合與 commands 由每個子規格／plan 凍結，不在此虛構。

## 3. 可平行與必須序列化的工作

4A 凍結後，4B codegen、4C 純交易模型、4D 各 OS runtime feasibility、4E 純 solver／CLI 驗證可用互不重疊的 write sets 平行。這是未來分工建議，不是本次啟動額外實作或代理的授權。

`plugin-protocol` schema／generated copies、registry／source identity、controller／launchers、persistence head／journal、desktop packaging／release scripts 都是 hotspot，需一位 writer 與停止後交接。4C 與 4D 先對齊 pins／lock／data generation；4E 的 UI／channel 整合再接收它們。三平台 4F 可分跑，但性能量測需獨占 host，最終 artifact／evidence join 由同一 owner 核對；修正成品後重跑受影響驗收。

## 4. 驗收與目前 handoff

不得放寬既有 assertions／budgets／thresholds，不得把 failed／partial／skipped／NOT RUN 改作 pass。新的安裝器 caps 是提案，核准後事前固定；不改 Stage 3 數值。原生硬體觀察、OS containment／durability、screen reader、乾淨機器安裝不能由單元測試替代。

本次文件沒有新增產品碼或測試程式；只對兩份 Markdown 做格式／適用 lint 與文件連結檢查。沒有執行 Electron、localhost server、原生安裝或硬體。Stage 3 orchestrator 的待跑命令與必要輸入見 提案 §11.4（草案：`../specs/2026-11-11-plugin-system-stage-4-packaging-proposal.md#114-本次未執行的-native-handoff`；尚未納入 git 追蹤），使用實際現存的 Node runners；Stage 4 新 commands 尚未實作。

尚未解除的外部依賴包括 Stage 3 final closeout／merge、R1／R2、H1–H6、publisher／runtime 供應選型、durability／data migration 契約與 owner 核准。WASM Host、marketplace、external device providers、HTML panels、剩餘 React/UI 過渡例外均不在本 outline 的隱含交付中。一般第三方開放只在 4F 完成後；不以 codegen、簽章或任一平台 smoke 成功提前宣布。
