# Sensor Lab 遷移與刪除驗證

日期：2026-10-26。範圍：3D 的 host 遷移 barrier 與實際 persistence worker；不是 Stage 3 或完整 D6/D7 驗收。

## 實作

- `b008503`：公開 `storage/delete` 在發布前 seal 零位元組 tombstone。reserve／seal／abort 回覆不明時保留原 ticket 與 target fence；重試只對帳原 ticket。同步刪除不得中斷仍在 seal 的原操作。
- `c4b9c69`：shipped worker 註冊 recordings／calibrations 兩個固定 mapper 與受限來源根目錄。Lab activation 必須等待兩個 durable marker 完成，並於 await 後重驗 owner、generation、host/process epoch 與 admission。
- 舊 Lab service 從建立時即停止新寫入與啟動讀檔；既有工作由原先的序列佇列完成。若 settlement 失敗，同一 service 生命週期內不以第二次嘗試掩蓋不確定結果。
- 遷移 gate 保留有界 mapped handle／原 publication ticket。新 owner 或重試先對帳與釋放舊 handle；未知結果維持阻擋。單一等待者取消不取消其他等待者。
- 已確定 committed 且 cleanup 完成的 host-only journal/recovery document，移入既有有界 tombstone，不再耗用 64 個 live entry 名額。公開 record ticket 及未知／未清理項目不受影響。

## 已執行的檢查

| 檢查 | 結果與邊界 |
| --- | --- |
| 公開 delete → 真 worker | 原缺 seal 的案例先失敗，修正後通過；重複同一請求回原 receipt。 |
| delete seal-sync 故障 | 原紀錄保持可讀；確認 abort 後才允許明確的新刪除。 |
| 不確定 admission／並行 delete | service 回歸測試通過；flush 不把未決 ticket 當作保存成功。 |
| record-service 全組 | 20 通過；新增測試先清除前置 complete() 的 mock 呼叫計數。 |
| worker 全組 | 39 通過，包含兩個實際 delete 回歸案例。 |
| gate／shipped import worker | 18 通過，包含原 handle 清理、owner 更替、停用與等待者取消。 |
| 大來源與 restart | 50 個各 8 MiB 的合法來源 JSON，加 4 個 profile，真 worker 完成匯入。刪一個目標後真正重啟 worker，剩餘 53 個目標保持原 host ID，刪除項目未重匯，54 個來源雜湊不變。 |
| 獨立 scoped review | PASS；另執行 45 項 service／legacy service 測試與 5 項真 worker 精選回歸。 |
| Desktop TypeScript／scoped ESLint | 通過。 |

大來源測試使用合法 JSON whitespace 填滿來源檔；它驗證來源讀取上限及多筆 journal 進度，不代表 400 MiB 的 canonical record payload 或目標 quota 已驗證。

對應可重跑測試：

- [record-service.test.ts](../../../apps/desktop/src/main/plugins/persistence/record-service.test.ts)
- [worker.test.ts](../../../apps/desktop/src/main/plugins/persistence/worker.test.ts)
- [shipped-import-worker.test.ts](../../../apps/desktop/src/main/plugins/persistence/shipped-import-worker.test.ts)
- [sensor-lab-migration-load.test.ts](../../../apps/desktop/src/main/plugins/persistence/sensor-lab-migration-load.test.ts)
- [service.test.ts](../../../apps/desktop/src/main/sensor-lab/service.test.ts)

```sh
pnpm exec vitest run apps/desktop/src/main/plugins/persistence/record-service.test.ts apps/desktop/src/main/plugins/persistence/worker.test.ts apps/desktop/src/main/plugins/persistence/shipped-import-worker.test.ts apps/desktop/src/main/plugins/persistence/sensor-lab-migration-load.test.ts apps/desktop/src/main/sensor-lab/service.test.ts
pnpm --filter @kobrixa/desktop check
```

## 尚未由本 receipt 證明

完整 canonical payload quota、所有 crash/marker 故障組合、真硬體、source-free installed Lab、完整公開 UI/CSV/profile 流程及 legacy UI 移除仍須各自證據。原生 Lab 流程正在迭代；其失敗不會被上述 Node worker 的通過結果覆蓋。
