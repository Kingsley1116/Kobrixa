import type { IconName } from "../../components/ui/icon.js";

type T = (zh: string, en: string) => string;
type Link = { href: string; label: string };

export type Stage = {
  id: string;
  step: string;
  tag: string;
  nav: string;
  title: string;
  lead: string;
  points: [title: string, body: string][];
  link: Link;
};

export type Tool = {
  icon: IconName;
  tag: string;
  title: string;
  body: string;
  link: Link;
  shot?: string;
};

export function featureContent(t: T, locale: "zh-TW" | "en") {
  const stages: Stage[] = [
    {
      id: "write",
      step: "01",
      tag: "EDITOR",
      nav: t("寫程式", "Write"),
      title: t("在本機，專心寫程式。", "A focused place to write."),
      lead: t(
        "以 Monaco 為基礎的 Basic Plus 編輯器。開一個資料夾、一個專案或單一 .bp 檔就能開始，不需帳號，也不需網路。",
        "A Basic Plus editor built on Monaco. Open a folder, a project or a single .bp file and start — no account, no internet required.",
      ),
      points: [
        [
          t("多專案分頁", "Project tabs"),
          t(
            "切換專案時保留檔案分頁、草稿、游標位置與 Undo 紀錄；關閉程式後，專案與草稿會在下次開啟時自動回來。",
            "Switch projects without losing file tabs, drafts, cursor positions or undo history. Quit and your projects and drafts reopen next time.",
          ),
        ],
        [
          t("補全與格式化", "Completion & formatting"),
          t(
            "語法高亮、括號配對、支援的 EV3 API 補全，以及一致的格式化。",
            "Syntax highlighting, bracket matching, completion for supported EV3 APIs and consistent formatting.",
          ),
        ],
        [
          t("雙語診斷與 Quick Fix", "Bilingual diagnostics & Quick Fix"),
          t(
            "每個錯誤代碼都有繁體中文與英文解說，離線可讀；確定的語法缺漏可以選取修正，並一步 Undo。",
            "Every diagnostic code is explained offline in English and Traditional Chinese. Unambiguous gaps can be fixed on request and undone in one step.",
          ),
        ],
      ],
      link: {
        href: "/docs/tutorial/first-program",
        label: t("寫第一個程式", "Write your first program"),
      },
    },
    {
      id: "build",
      step: "02",
      tag: "COMPILER",
      nav: t("建置", "Build"),
      title: t("從 .bp 到原生 .rbf。", "From .bp to native .rbf."),
      lead: t(
        "支援的 Basic Plus 程式先轉成經過驗證的 KobrixaIR，再在你的電腦上編譯成 EV3 原生執行檔。",
        "Supported Basic Plus programs become validated KobrixaIR, then compile on your own computer into native EV3 executables.",
      ),
      points: [
        [
          t("背景編譯", "Builds in the background"),
          t(
            "編譯在獨立 worker 執行並顯示進度，期間仍可編輯其他專案。",
            "Compilation runs in its own worker with progress, so you can keep editing other projects.",
          ),
        ],
        [
          t("隨時取消", "Cancel any time"),
          t(
            "取消的建置不會覆蓋上一次成功的成品。",
            "A cancelled build never replaces your last successful artifact.",
          ),
        ],
        [
          t("精確、可預期的錯誤", "Precise, predictable errors"),
          t(
            "診斷代碼固定，並標示檔案與行列範圍；只要有錯誤，就不會產出可部署的檔案。",
            "Diagnostics carry stable codes with file, line and column ranges. If there is an error, nothing deployable is produced.",
          ),
        ],
      ],
      link: {
        href: "/docs/reference/language-support",
        label: t("了解語言支援", "Explore language support"),
      },
    },
    {
      id: "run",
      step: "03",
      tag: "CONNECTION",
      nav: t("上機", "Run"),
      title: t("把程式帶到機器人上。", "Put your code on the brick."),
      lead: t(
        "透過 USB 或 Wi-Fi 連上 EV3，上傳、執行、停止程式。每個操作都有明確結果，失敗時也會告訴你怎麼恢復。",
        "Connect over USB or Wi-Fi to upload, run and stop programs. Every operation reports a clear result, with recovery guidance when something fails.",
      ),
      points: [
        [
          t("USB 或 Wi-Fi", "USB or Wi-Fi"),
          t(
            "自動偵測 USB 上的 EV3，或輸入位址透過 Wi-Fi 連線。Wi-Fi 只用來連機器人，不依賴雲端。",
            "Discover an EV3 over USB, or connect to its Wi-Fi address. Wi-Fi talks to the brick, never to a cloud service.",
          ),
        ],
        [
          t("只傳需要的檔案", "Upload only what changed"),
          t(
            "素材大小與校驗碼相同就略過，執行檔永遠最後上傳；也能在設定中改回完整上傳。",
            "Unchanged assets are skipped by size and checksum, and the executable always goes last. Switch to full uploads in Settings.",
          ),
        ],
        [
          t("檔案管理與馬達測試", "Files & motor tests"),
          t(
            "瀏覽 EV3 上的檔案、傳輸資料夾並預覽衝突；用點動、定時與角度控制測試馬達。",
            "Browse files on the brick, transfer folders with conflict previews, and test motors with jog, timed and angle controls.",
          ),
        ],
      ],
      link: {
        href: "/docs/reference/device-support",
        label: t("查看裝置支援", "Check device support"),
      },
    },
  ];

  const shot = (name: string) => `${name}-${locale}.png`;
  const tools: Tool[] = [
    {
      icon: "users",
      tag: "COLLABORATION",
      title: t("同一個專案，一起完成。", "Work on the same project together."),
      body: t(
        "用邀請碼與選填密碼開房間，即時共同編輯、共享檔案樹與聊天，並由一個人持有 EV3 控制權。不需帳號；協作需要網路。",
        "Open a room with an invite code and optional password to co-edit, share the file tree, chat and pass EV3 control. No account needed; collaboration requires internet access.",
      ),
      link: {
        href: "/docs/reference/collaboration",
        label: t("了解雲端協作", "Explore collaboration"),
      },
      shot: shot("collaboration"),
    },
    {
      icon: "chart",
      tag: "SENSOR LAB",
      title: t("把讀值，變成看得見的曲線。", "Turn readings into visible patterns."),
      body: t(
        "記錄感測器與馬達計數、比較多次實驗並匯出 CSV。兩點校正與歸零會產生可直接複製的 Basic Plus 範例。",
        "Record sensor readings and motor counts, compare runs and export CSV. Two-point calibration and zeroing generate Basic Plus you can copy straight into your program.",
      ),
      link: { href: "/docs/reference/sensor-lab", label: t("使用 Sensor Lab", "Use Sensor Lab") },
      shot: shot("sensor-lab"),
    },
    {
      icon: "audio",
      tag: "MEDIA STUDIO",
      title: t("讓 EV3 有畫面，也有聲音。", "Give your EV3 a face and a voice."),
      body: t(
        "在瀏覽器把圖片轉成 RGF、音訊轉成 RSF，支援黑白預覽、抖色與波形裁切，檔案不離開你的電腦。",
        "Convert images to RGF and audio to RSF in your browser, with monochrome previews, dithering and waveform trimming. Your files never leave your computer.",
      ),
      link: { href: "/tools", label: t("開啟媒體工作室", "Open the media studio") },
    },
    {
      icon: "image",
      tag: "GALLERY",
      title: t("讓素材，也能一起分享。", "Share what your robot shows and plays."),
      body: t(
        "下載經過審核的 EV3 圖片、音訊與播放範例；用 GitHub 登入即可投稿，審核後以 CC BY 4.0 公開。",
        "Download reviewed EV3 images, audio and playback examples. Sign in with GitHub to submit your own for review under CC BY 4.0.",
      ),
      link: { href: "/gallery", label: t("瀏覽社群素材庫", "Browse the gallery") },
    },
    {
      icon: "book",
      tag: "LEARNING",
      title: t("從小練習，走到完整專案。", "Start small. Build something real."),
      body: t(
        "跟著教學練習顯示、聲音、馬達與感測器，再查 API 參考與範例，組合成自己的機器人專案。",
        "Practice displays, sound, motors and sensors with tutorials, then use the API reference and examples to build your own robot project.",
      ),
      link: { href: "/docs/tutorial", label: t("瀏覽學習路徑", "Explore the learning path") },
    },
  ];

  const audiences: [IconName, string, string][] = [
    [
      "book",
      t("學生", "Students"),
      t(
        "從積木程式跨到文字程式。錯誤訊息用你看得懂的語言解釋原因與下一步。",
        "Moving from blocks to text. Error messages explain the cause and the next step in a language you read.",
      ),
    ],
    [
      "code",
      t("創客", "Makers"),
      t(
        "維護或延伸既有的 .bp 機器人程式。支援的程式不需修改就能開啟、編譯並上機。",
        "Maintaining or extending existing .bp robot programs. Supported programs open, compile and run without changes.",
      ),
    ],
    [
      "users",
      t("教學者", "Mentors"),
      t(
        "在 Windows、macOS 與 Linux 上用同一套流程與範例帶課，學生的電腦不需要帳號。",
        "Teach with the same workflow and examples on Windows, macOS and Linux, with no accounts to set up for students.",
      ),
    ],
  ];

  const offline = [
    t("編輯、補全與格式化", "Editing, completion and formatting"),
    t("編譯成 .rbf", "Compiling to .rbf"),
    t("雙語診斷解說與 Quick Fix", "Bilingual diagnostics and Quick Fix"),
    t("透過 USB 或區域網路 Wi-Fi 操作 EV3", "Driving an EV3 over USB or local Wi-Fi"),
    t("Sensor Lab 與馬達測試", "Sensor Lab and motor tests"),
  ];
  const online = [
    t("雲端協作房間", "Cloud collaboration rooms"),
    t("社群素材庫瀏覽與投稿", "Browsing and submitting to the gallery"),
    t("官網錯誤索引與文件", "The online diagnostic index and docs"),
    t("檢查與下載更新", "Checking for and downloading updates"),
  ];

  const faq: [string, string, Link?][] = [
    [
      t("需要註冊帳號嗎？", "Do I need an account?"),
      t(
        "不需要。編輯、編譯與操作 EV3 都不用帳號；雲端協作只需邀請碼。只有在社群素材庫投稿時需要以 GitHub 登入。",
        "No. Editing, compiling and driving an EV3 need no account, and collaboration only needs an invite code. Signing in with GitHub is required only to submit to the gallery.",
      ),
    ],
    [
      t("支援哪些作業系統？", "Which operating systems are supported?"),
      t(
        "Windows x64、搭載 Apple Silicon 的 macOS，以及 Linux x64。Intel Mac 目前不在支援範圍。",
        "Windows x64, macOS on Apple Silicon and Linux x64. Intel Macs are currently out of scope.",
      ),
      { href: "/download", label: t("前往下載", "Go to downloads") },
    ],
    [
      t("我的 .bp 程式可以直接打開嗎？", "Will my existing .bp programs open?"),
      t(
        "支援的 .bp 程式不需修改即可開啟與編譯；遇到尚未支援的語法，會以明確的診斷告訴你位置與原因。",
        "Supported .bp programs open and compile without changes. Unsupported syntax produces a diagnostic that tells you where and why.",
      ),
      { href: "/docs/reference/language-support", label: t("語言支援", "Language support") },
    ],
    [
      t("支援 Python、藍牙或積木程式嗎？", "Is there Python, Bluetooth or a block editor?"),
      t(
        "目前沒有。Python、TypeScript 與 C++ 前端列在路線圖上；藍牙與積木編輯器屬於長期探索方向，還不是承諾。",
        "Not yet. Python, TypeScript and C++ frontends are on the roadmap; Bluetooth and a block editor are long-term explorations, not commitments.",
      ),
      { href: "/docs/reference/roadmap", label: t("開發路線圖", "Roadmap") },
    ],
    [
      t("安裝檔有數位簽章嗎？", "Are the installers signed?"),
      t(
        "1.0.0 在 macOS、Windows 與 Linux 上皆未簽章，安裝時系統可能顯示警告。每個版本的簽章狀態都寫在該版的 Release 說明中。",
        "1.0.0 is unsigned on macOS, Windows and Linux, so your system may show a warning during installation. Each Release's notes state its signing status.",
      ),
      { href: "/docs/reference/code-signing", label: t("程式碼簽章政策", "Code signing policy") },
    ],
    [
      t("需要付費嗎？", "Does it cost anything?"),
      t(
        "不用。Kobrixa 免費提供，並以 Apache-2.0 授權開放原始碼。",
        "No. Kobrixa is free and open source under the Apache-2.0 license.",
      ),
    ],
  ];

  return { stages, tools, audiences, offline, online, faq };
}
