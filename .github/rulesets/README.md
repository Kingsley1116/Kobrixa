# Repository protection / 儲存庫保護

## English

These JSON files record the intended GitHub rulesets for the default branch (`main`). Committing them does not apply GitHub settings; administrators must also update the matching ruleset in [repository settings](https://github.com/Kingsley1116/Kobrixa/settings/rules).

- **Main branch safety** blocks force pushes and branch deletion with no bypass actors, including administrators.
- **Main branch workflow** requires a pull request, resolved review threads, a branch up to date with the latest base, and a passing `CI result` from GitHub Actions (integration ID `15368`). Repository administrators (role ID `5`, currently the owner) have an **Always allow** bypass, so they can push directly to `main` without a PR or passing CI. The existing CI result job checks every affected product and rejects failed, cancelled or unexpectedly skipped jobs.
- **Main branch review** requires one approval and a code owner's approval for paths in [CODEOWNERS](../CODEOWNERS). New reviewable commits dismiss stale approvals. Repository administrators also have an **Always allow** bypass here, allowing direct pushes without review. Other contributors remain subject to all three rulesets.

### Optional direct commit without CI

As a repository administrator, commit on `main` and include `[skip ci]` in the commit message when you want to skip CI for that push:

```sh
git switch main
git pull --ff-only origin main
git add <files>
git commit -m "Describe the change [skip ci]"
git push origin main
```

Without `[skip ci]`, direct administrator pushes still bypass the workflow and review rulesets but CI runs normally. GitHub's skip marker applies to workflows triggered by `push` and `pull_request`, including this repository's CI and CodeQL workflows; scheduled CodeQL scans and manual workflow runs still run. Skipping CI does not grant bypass permission: contributors without administrator access still need a PR and successful required checks, and a skipped required check leaves their PR blocked. The administrator bypass is a GitHub permission, not a Git push flag.

Other repository settings:

- Private vulnerability reporting, Dependabot alerts and security updates, secret scanning and push protection are enabled.
- Workflows from all external fork contributors require maintainer approval. Inspect the proposed code and workflow changes before allowing execution.
- Default Actions token permissions remain read-only, and Actions cannot approve pull requests. Trusted release jobs explicitly request write permissions where needed.
- Merged branches are deleted automatically, and the update-branch action is available. Existing merge methods remain available.

To update a ruleset, find its ID with `gh api repos/Kingsley1116/Kobrixa/rulesets`, then use `gh api --method PUT repos/Kingsley1116/Kobrixa/rulesets/ID --input .github/rulesets/main-protection.json` (or `main-workflow.json` / `main-review.json`). Use `POST` to the rulesets collection only when creating a missing rule; do not create duplicates. When migrating from the original two rulesets, create **Main branch workflow** before removing its PR and CI rules from **Main branch safety**, so other contributors remain protected throughout. Verify the saved rules and bypass actors after every change. Renaming the `CI result` job also requires updating the GitHub check requirement.

References: [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [ruleset bypass permissions](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset), [skipping workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs), [fork workflow approval](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks).

## 繁體中文

這些 JSON 檔案記錄預設分支（`main`）的 GitHub 規則。提交檔案不會自動套用設定；管理員也必須在[儲存庫設定](https://github.com/Kingsley1116/Kobrixa/settings/rules)更新對應規則。

- **Main branch safety** 禁止強制推送與刪除分支，沒有略過名單，管理員也須遵守。
- **Main branch workflow** 要求透過 PR、解決審核討論串、更新至最新基底分支，並通過 GitHub Actions（integration ID `15368`）的 `CI result`。儲存庫管理員（role ID `5`，目前為擁有者）具有 **Always allow** 略過權限，因此可直接推送至 `main`，不需要 PR 或等待 CI 通過。現有 CI 彙整工作會確認每項受影響產品成功，拒絕失敗、取消或非預期跳過的工作。
- **Main branch review** 要求一位核准，且修改 [CODEOWNERS](../CODEOWNERS) 指定路徑時需要該負責人核准。新的可審核提交會使舊核准失效。儲存庫管理員在這組規則也具有 **Always allow** 略過權限，可不經審核直接推送。其他貢獻者仍須遵守三組規則。

### 選擇直接提交並跳過 CI

以儲存庫管理員身分在 `main` 提交，需要跳過該次推送的 CI 時，在 commit message 加入 `[skip ci]`：

```sh
git switch main
git pull --ff-only origin main
git add <files>
git commit -m "描述這次修改 [skip ci]"
git push origin main
```

不加 `[skip ci]` 時，管理員仍可直接推送並略過 workflow 與 review rulesets，但 CI 會照常執行。GitHub 的跳過標記適用於 `push` 與 `pull_request` 觸發的工作流程，包含本專案的 CI 與 CodeQL；排程 CodeQL 掃描與手動執行不受影響。跳過 CI 不會授予略過權限：非管理員仍需要 PR 與成功的必要檢查，略過必要檢查會使其 PR 無法合併。管理員 bypass 是 GitHub 權限，不是 Git push 參數。

其他儲存庫設定：

- 啟用私人漏洞回報、Dependabot 漏洞警示與安全更新、機密掃描及推送保護。
- 所有外部 fork 貢獻者的工作流程都需要維護者核准執行；核准前應檢查程式碼與工作流程變更。
- Actions 預設權杖維持唯讀，且無法核准 PR；受信任的發布工作只在需要時明確要求寫入權限。
- 合併後自動刪除分支，並提供更新分支操作；保留原有合併方式。

更新規則時，先以 `gh api repos/Kingsley1116/Kobrixa/rulesets` 找到 ID，再執行 `gh api --method PUT repos/Kingsley1116/Kobrixa/rulesets/ID --input .github/rulesets/main-protection.json`（或 `main-workflow.json`／`main-review.json`）。只有規則不存在時才對 rulesets 集合使用 `POST`，避免重複建立。從原本兩組規則遷移時，須先建立 **Main branch workflow**，再從 **Main branch safety** 移除 PR 與 CI 規則，確保其他貢獻者的保護不中斷。每次修改後都應確認實際規則與略過名單。若重新命名 `CI result` 工作，必須同步更新 GitHub 的必要檢查設定。
