# 靜態語言插件

插件 API 1.4.0 允許可信任的本機開發插件，以 JSON 提供詞法上色及編輯器設定。靜態語言不會增加編譯器、隱式專案推斷或語言服務。Basic Plus 仍是唯一隨附的來源前端；第三方 `frontends`、`backends`、`languageServices` 仍禁止宣告，空陣列也不例外。符合 host API range 的既有 1.x 插件繼續載入。

## 完整的純靜態插件

在同一資料夾建立下列三個檔案。這是共用的 `acme.toy` 驗收 fixture，沒有執行入口、SDK 初始化、註冊 RPC 或插件程序。

`kobrixa-plugin.json`：

```json
{
  "id": "acme.toy",
  "version": "1.0.0",
  "apiVersion": "^1.4.0",
  "displayName": "Toy static language",
  "runtime": { "kind": "static" },
  "contributes": {
    "languages": [
      {
        "id": "toy",
        "extensions": ["toy"],
        "aliases": ["Toy"],
        "tokenizer": { "version": 1, "path": "language/tokenizer.json" },
        "configuration": { "version": 1, "path": "language/configuration.json" }
      }
    ]
  }
}
```

`language/tokenizer.json`：

```json
{
  "ignoreCase": false,
  "defaultToken": "invalid",
  "states": [
    {
      "name": "root",
      "rules": [
        { "regex": { "pattern": "[ \\t]+", "flags": "" }, "action": { "token": "white" } },
        {
          "regex": { "pattern": "[A-Za-z_][A-Za-z0-9_]*", "flags": "" },
          "action": { "token": "identifier" }
        },
        { "regex": { "pattern": "[0-9]+", "flags": "" }, "action": { "token": "number" } }
      ]
    }
  ]
}
```

`language/configuration.json`：

```json
{}
```

版本放在資源宣告的 `version: 1`，JSON 本體不重複版本欄位。兩份資源都必填；空 configuration 使用 Monaco 預設，不接受 inline configuration。資源必須是封裝內相對 `.json` 路徑，最多 600 字元、七層目錄，不能使用 URL、絕對路徑、反斜線或 `..` segment；symlink 也不能越出連結的資料夾。

`runtime: {"kind":"static"}` 只接受 `kind`。不可宣告 `entry`、`activationEvents`、`permissions`、commands、frontends、backends、languageServices，空陣列也不合法。至少需要非空 languages 或有效 diagnosticHelp；資源失敗只拒絕該語言，不反過來使已合法的 runtime 失效。Node／Python 插件也能提供靜態資源；只讀語法不會啟動程序。

## 載入、重新載入與復原

在「設定 → 插件」經原生信任確認開啟開發者模式，再連結資料夾。也可用 `--plugin-dev-dir=/absolute/path/to/toy` 啟動；多資料夾在 macOS／Linux 用 `:`，Windows 用 `;` 分隔。修改後按重新載入；啟用／停用以整個插件為單位，依來源身分持久保存。沒有 PID 的純靜態插件仍可處於啟用狀態。

只載入可信任作者提供的語法。JSON 雖是資料，其中 regex 仍在編輯器執行，可能阻塞 renderer。驗證不是 ReDoS 證明、沙箱或可中斷 worker。每來源 I/O 與首次 IPC 等待的 5,000 ms 上限不能中斷同步 regex。長度 ≥10,000 UTF-16 code units 的行跳過詞法 tokenization；這不限制縮排、on-enter、word-pattern 的輸入，也不保證短 pattern 安全。

宿主在交付第三方 catalog 前，同步保存 `thirdPartyStaticContributions`，沒有程序的插件也適用；本次 session 內即使停用仍保持 true。寫入失敗以 `PLUGIN_E_STATE_SAVE` 阻止第三方語法交付，保留 builtin／純文字編輯。舊 marker 缺欄位時視為 false。交付後非正常退出，下次啟動進入安全模式；renderer-unresponsive 原因優先。正常結束會清除 marker，但曾無回應的 renderer 仍需保留復原原因。

視窗卡住時，結束並重新啟動，必要時加 `--safe-mode`。安全模式不讀第三方資料夾，保留 Basic Plus 及內建服務；下一次啟動的復原設定不依賴卡住的 renderer。「恢復插件」必須由使用者明確操作，不會重新啟用個別持久停用來源，也無法結束 CLI `--safe-mode` session。不要依賴已被同步 regex 卡住的畫面按鈕來撤銷語法。

## 資源格式 v1

所有 objects 都是 strict，未列欄位會被拒絕。state／list／rule／case arrays 保留順序。必須包含 `root`；名稱符合 `^[a-z][a-z0-9_]{0,31}$`。state 保留 `pop`、`popall`、`push`，list 保留 `default`、`eos`，map key 保留 `__proto__`、`constructor`、`prototype`。

Tokenizer rule 是 `{regex, action}` 或本地 `include: "@state"`。Include 必須存在、無循環且符合展開上限，未被引用的 states 也驗證。Action 可為 literal `token` 搭配選填 `next`／`bracket`，或有序 `cases`；分支使用 `@list`、`@eos`，最後必須有且只有一個 `@default`。禁止巢狀 cases 與任意 guard。Transition 只接受現有 `@state`、`@pop`、`@popall`；合法 transition cycle 不等於 include cycle。`@brackets` 要求 tokenizer bracket table，不能另覆寫 `bracket`。

每個 regex 必填 `pattern` 與 `flags`，flags 只能是 `""` 或 `"i"`。Tokenizer 的每筆 flags 必須等於 `ignoreCase ? "i" : ""`；configuration 各筆可獨立選擇。Pattern 是 ECMAScript regex source；正常書寫 literal `@`、`@@`、`@name`、`$`，adapter 會保護其字面語意。`$S`／`$s` 後接數字一律拒絕，即使 escaped 也不例外。拒絕 backreference、lookbehind、不支援語法及無法證明至少消耗一個 code unit 的 tokenizer rule；允許 lookahead。Configuration anchor 可經同一個依用途區分的 validator 接受零寬匹配。

V1 不接受 functions、imports、modules、callbacks、remote resources、external includes、自訂 macros、capture-action arrays、tuple shortcuts、動態 substitution、`@push`、`@rematch`、`goBack`、`switchTo`、`nextEmbedded`、`log`、`unicode`、`includeLF` 或自訂 `start`。字串不會當 JavaScript 執行。

Configuration 可包含 comments、brackets、帶 `notIn` 的 autoClosingPairs、surroundingPairs、indentationRules、onEnterRules、wordPattern。On-enter 縮排動作為 `none`、`indent`、`indentOutdent`、`outdent`。完整欄位及公開 strict schemas `static-language-tokenizer-v1`、`static-language-configuration-v1` 見[正式設計 §2–§4](../superpowers/specs/2026-10-17-plugin-system-2c-static-languages-design.md)。Zod、draft-2020-12 JSON Schema 與 SDK conformance 共用格式；Python 不使用 Python regex 引擎驗證 ECMAScript patterns。

## 固定限制

`STATIC_LANGUAGE_FORMAT_VERSION = 1` 綁定不可變的 `STATIC_LANGUAGE_LIMITS_V1`。插件不能提高上限；格式／限制不相容變更必須新增版本。字串長度計算解碼後 Unicode code points，只有 editor 長行門檻採 UTF-16 code units。資源以原始 UTF-8 bytes 計量，包含 BOM；重複 path 引用每次計費。

| 限制                                     |                              數值 |
| ---------------------------------------- | --------------------------------: |
| Pattern／adapter compiled pattern        |          2,048／4,096 code points |
| 每語言 raw rules／regexes                |                      1,024／1,024 |
| States／keyword lists                    |                            64／32 |
| 每語言 words／每 word 字數               |                         4,096／64 |
| 每 rule cases／on-enter rules            |                            32／32 |
| 每 resource／語言／插件                  | 524,288／786,432／1,048,576 bytes |
| 所有活動資源                             |                   8,388,608 bytes |
| 每語言／全部 expanded rules              |                     8,192／65,536 |
| Include depth                            |                          16 edges |
| 每插件／活動 language ids                |                            8／128 |
| 每 renderer session 註冊過的插件語言 ids |          256；第 257 個需重新啟動 |
| 詞法長行門檻                             |          10,000 UTF-16 code units |

Extensions 為 1–16 筆不重複值，每筆 1–16 個小寫英數字、無前導點。語言 id 符合 `^[a-z][a-z0-9-]{0,31}$`。Aliases 為 1–8 筆不重複單行文字，每筆 1–80 code points；第一筆為標籤，省略時用 id。Token／postfix 最多 80；pair／comment atom 1–16；各配對表最多 32，`notIn` 最多三個不重複值。On-enter `appendText` 最多 256 code points，`removeText` 是 0–256 整數。字串不接受控制字元，但 regex 文字 escape 可表達控制字元匹配。所有 states 與 configuration regex 欄位都納入合計。

## Ownership、純文字與問題回報

解析次序是核心 → 適用 selected binding 的同 owner static → 唯一 global extension → 純文字。核心 JSON／plaintext ids 與 `.json` 保留。Selected binding 的 owner 缺少語法時，不會借用另一插件。沒有適用 binding 時，不同語言共用 extension 使 global mapping ambiguous，不依載入順序選 winner；其他 extensions 與語言註冊仍保留。純靜態 id 重複時排除全部參與者。Alias 不決定 ownership。Frontend 語法失敗仍保留 logical id；同 owner 的 frontend／service／static extension 集合必須相等。

停用、移除或失敗 reload 會把可見、隱藏與 review models 改為純文字，保留內容、undo、draft、cursor、view state；重新啟用後恢復符合條件的已開文件。Lexical revision 與 service epoch 分離；語法失敗不使健康的分析服務 unavailable。Fallback 清除 semantic coloring。Basic Plus Monaco id 為 `bp`，token postfix 保持 `.basic-plus`，keywords、comments、pairs、縮排與主題不變。內建不可停用，回 `PLUGIN_E_BUILTIN_REQUIRED`。

| 問題碼                                  | 意義                                                             |
| --------------------------------------- | ---------------------------------------------------------------- |
| `PLUGIN_E_MANIFEST`                     | 宣告、static runtime 語意或同 owner extension 集合不合法         |
| `PLUGIN_E_STATIC_LANGUAGE`              | 資源、格式、regex、include、I/O 或預算失敗；只拒絕該語言         |
| `PLUGIN_E_STATIC_LANGUAGE_CONFLICT`     | Ownership／id 衝突或 ambiguous／保留 extension；列出所有參與來源 |
| `PLUGIN_E_STATIC_LANGUAGE_REGISTRATION` | Renderer validation、adapter、Monaco 或 session id 上限失敗      |

插件設定顯示 plugin id、`detail.languageId`、相對 `resourcePath`、適用的 `fieldPath`，以及 limit 的 `allowed`／`actual` 或衝突來源。只有 reload 或明確 enable 才重試已隔離 generation，catalog 通知不會造成重試迴圈。本功能不加入 marketplace、theme contributions、file-association UI、glob／filename／first-line 配對或第三方 language-service RPC。
