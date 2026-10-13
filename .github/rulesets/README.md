# Repository protection / 儲存庫保護

## English

These JSON files record the intended GitHub rulesets for the default branch (`main`). Committing them does not apply GitHub settings; administrators must also update the matching ruleset in [repository settings](https://github.com/Kingsley1116/Kobrixa/settings/rules).

- **Main branch safety** has no bypass actors. Everyone must use a pull request, resolve review threads, update the branch with the latest base, and pass `CI result` from GitHub Actions (integration ID `15368`). Force pushes and branch deletion are blocked. The existing CI result job checks every affected product and rejects failed, cancelled or unexpectedly skipped jobs.
- **Main branch review** requires one approval and a code owner's approval for paths in [CODEOWNERS](../CODEOWNERS). New reviewable commits dismiss stale approvals. Repository administrators (role ID `5`, currently the owner) may bypass this review ruleset only through a pull request. This exception cannot bypass the separate safety ruleset or its CI requirement.

Other repository settings:

- Private vulnerability reporting, Dependabot alerts and security updates, secret scanning and push protection are enabled.
- Workflows from all external fork contributors require maintainer approval. Inspect the proposed code and workflow changes before allowing execution.
- Default Actions token permissions remain read-only, and Actions cannot approve pull requests. Trusted release jobs explicitly request write permissions where needed.
- Merged branches are deleted automatically, and the update-branch action is available. Existing merge methods remain available.

To update a ruleset, find its ID with `gh api repos/Kingsley1116/Kobrixa/rulesets`, then use `gh api --method PUT repos/Kingsley1116/Kobrixa/rulesets/ID --input .github/rulesets/main-protection.json` (or `main-review.json`). Use `POST` to the rulesets collection only when creating a missing rule; do not create duplicates. Verify the saved rules and bypass actors after every change. Renaming the `CI result` job also requires updating the GitHub check requirement.

References: [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [fork workflow approval](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks).

## 繁體中文

這些 JSON 檔案記錄預設分支（`main`）的 GitHub 規則。提交檔案不會自動套用設定；管理員也必須在[儲存庫設定](https://github.com/Kingsley1116/Kobrixa/settings/rules)更新對應規則。

- **Main branch safety** 沒有略過名單。所有人都必須透過 PR、解決審核討論串、更新至最新基底分支，並通過 GitHub Actions（integration ID `15368`）的 `CI result`。禁止強制推送與刪除分支。現有 CI 彙整工作會確認每項受影響產品成功，拒絕失敗、取消或非預期跳過的工作。
- **Main branch review** 要求一位核准，且修改 [CODEOWNERS](../CODEOWNERS) 指定路徑時需要該負責人核准。新的可審核提交會使舊核准失效。儲存庫管理員（role ID `5`，目前為擁有者）只能透過 PR 略過這組人工審核規則，無法略過獨立的安全規則或 CI。

其他儲存庫設定：

- 啟用私人漏洞回報、Dependabot 漏洞警示與安全更新、機密掃描及推送保護。
- 所有外部 fork 貢獻者的工作流程都需要維護者核准執行；核准前應檢查程式碼與工作流程變更。
- Actions 預設權杖維持唯讀，且無法核准 PR；受信任的發布工作只在需要時明確要求寫入權限。
- 合併後自動刪除分支，並提供更新分支操作；保留原有合併方式。

更新規則時，先以 `gh api repos/Kingsley1116/Kobrixa/rulesets` 找到 ID，再執行 `gh api --method PUT repos/Kingsley1116/Kobrixa/rulesets/ID --input .github/rulesets/main-protection.json`（或 `main-review.json`）。只有規則不存在時才對 rulesets 集合使用 `POST`，避免重複建立。每次修改後都應確認實際規則與略過名單。若重新命名 `CI result` 工作，必須同步更新 GitHub 的必要檢查設定。
