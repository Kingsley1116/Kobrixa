export const POLICY_DATE = "2026-09-24";
export const LEGAL_OPERATOR = "Kobrixa 專案維護者 Kingsley1116";
export const LEGAL_EMAIL = "support@kobrixa.com";
export type LegalKind = "terms" | "privacy";
type Section = { id: string; title: string; body: string };
type Policy = { title: string; intro: string; sections: Section[] };

export function legalContent(kind: LegalKind, locale: "zh-TW" | "en"): Policy {
  const zh = locale === "zh-TW";
  const contact = `[${LEGAL_EMAIL}](mailto:${LEGAL_EMAIL})`;
  if (kind === "terms")
    return zh
      ? {
          title: "服務條款",
          intro:
            "這些條款說明 Kobrixa 網站與 EV3 素材庫的使用規則。請在登入、儲存草稿或投稿前閱讀。",
          sections: [
            {
              id: "service",
              title: "1. 服務與營運者",
              body: `本網站由 ${LEGAL_OPERATOR} 維護，提供產品資訊、文件、瀏覽器媒體工具及經審核的 EV3 素材庫。網站使用規則與素材授權不同：Kobrixa 軟體另依其 [Apache-2.0 授權](https://github.com/Kingsley1116/Kobrixa/blob/main/LICENSE) 提供，Gallery 公開素材依作品頁標示的 CC BY 4.0 提供。Kobrixa 與 LEGO Group 無隸屬、認可或贊助關係。`,
            },
            {
              id: "account",
              title: "2. 帳號與使用資格",
              body: "公開素材可免登入瀏覽、試聽及下載；投稿需使用 GitHub 登入。請保護自己的 GitHub 帳號，只以有權使用的帳號操作，並遵守 GitHub 的適用條款。如果你尚未具備所在地法律要求的締約能力，請由家長或法定代理人閱讀並同意後，在其協助下使用投稿功能。\n\n登入入口提供本條款與隱私政策；儲存草稿或送審代表你同意本服務條款。隱私政策用來說明資料處理，不是另行授予行銷或素材使用權的同意書。",
            },
            {
              id: "uploads",
              title: "3. 投稿與權利",
              body: "你保留自己作品的權利，並須確保有權上傳、供管理員審閱及依所選授權公開作品。第三方圖片、音樂、人物肖像、聲音、商標或其他受保護內容可能需要額外許可；可從網路下載不代表可以重新分享。\n\n儲存或送審時，你允許營運者為提供服務而保存 EV3 成品、產生預覽、處理審核與安全檢查。只有通過審核並公開的作品才提供公眾預覽及下載。請勿在素材或說明內放入不宜公開的個人資料、機密、金鑰或登入憑證。",
            },
            {
              id: "license",
              title: "4. 公開素材：CC BY 4.0",
              body: "送審前，你需確認分享權利並同意作品經核准後以 [Creative Commons 姓名標示 4.0 國際授權（CC BY 4.0）](https://creativecommons.org/licenses/by/4.0/) 公開。此授權允許他人分享、改作及商業使用。使用者須適當署名、附上授權連結並標示修改，不得暗示作者背書，也不得加上限制授權所允許行為的條件或技術措施。\n\n在使用者遵守授權的情況下，已授予的授權不能撤銷；撤下作品無法收回他人已合法取得的副本或授權。隱私、肖像、商標等其他權利仍可能限制特定使用。詳細權利義務以 [CC BY 4.0 完整授權條款](https://creativecommons.org/licenses/by/4.0/legalcode) 為準。草稿及未公開投稿不因儲存而自動成為公眾可使用的素材。",
            },
            {
              id: "conduct",
              title: "5. 禁止行為",
              body: "不得投稿侵犯著作權、隱私或其他權利的內容，或違法、威脅、騷擾、仇恨、性剝削及其他不適合公開教育社群的素材。不得散布惡意檔案、假冒他人、規避審核或投稿限額、嘗試未授權存取，或以濫用請求妨礙服務。\n\n目前接受的格式、檔案大小與投稿次數以投稿介面顯示為準；不得將限制繞過用於未支援的檔案或用途。",
            },
            {
              id: "moderation",
              title: "6. 審核、撤下與申訴",
              body: "管理員可因權利疑慮、違規、檔案問題或服務維運需要拒絕或撤下素材。審核結果及理由可在「我的作品」查看；審核通過不代表營運者保證作品不侵權。作者可撤下待審或已公開作品，修改後需重新送審，不能自行核准公開。\n\n撤下會停止本網站的公開存取，不會自動刪除帳號、檔案或審核紀錄。資料處理及刪除申請請參閱 [隱私政策](/privacy#retention)。",
            },
            {
              id: "reports",
              title: "7. 侵權申訴與聯絡",
              body: `請寄信至 ${contact}，提供作品網址、問題說明、你主張的權利或與作品的關係，以及可回覆的聯絡方式。營運者可能要求合理的補充資料以核實申請，並視情況限制存取、聯絡投稿者或更正處理結果。請勿寄送密碼、金鑰或不必要的身分證件，也不要把敏感資料貼在公開 GitHub issue。`,
            },
            {
              id: "availability",
              title: "8. 服務可用性與責任",
              body: "服務及素材依現況提供，可能因維護、安全、資源限制或其他原因調整或中斷；請自行保留原始檔及備份。使用前請確認素材適合你的 EV3 裝置、程式及使用情境。\n\n在適用法律允許的範圍內，營運者不保證服務不中斷、素材適用於特定用途或完全無錯誤。本條款不排除或限制依法不能排除的責任，也不影響你依法享有的強制性權利。",
            },
            {
              id: "changes",
              title: "9. 條款更新",
              body: "本頁會標示更新日期；影響投稿或資料使用的重要變更會在網站相關入口提示，依法或變更性質需要時會重新取得同意。更新不會追溯撤銷既有的 CC BY 4.0 授權。繁中與英文內容旨在表達相同規則；如發現翻譯差異，請透過上述聯絡方式通知營運者。",
            },
          ],
        }
      : {
          title: "Terms of Service",
          intro:
            "These terms explain how to use the Kobrixa website and EV3 Gallery. Read them before signing in, saving a draft, or submitting media.",
          sections: [
            {
              id: "service",
              title: "1. Service and operator",
              body: "This website is maintained by Kobrixa project maintainer Kingsley1116. It provides product information, documentation, browser-based media tools, and a moderated EV3 Gallery. These website rules are separate from content licences: Kobrixa software is provided under its [Apache-2.0 licence](https://github.com/Kingsley1116/Kobrixa/blob/main/LICENSE), while published Gallery media uses the CC BY 4.0 licence shown on each entry. Kobrixa is not affiliated with, endorsed by, or sponsored by the LEGO Group.",
            },
            {
              id: "account",
              title: "2. Accounts and eligibility",
              body: "Public media can be browsed, previewed and downloaded without an account. Contributions require GitHub sign-in. Protect your GitHub account, use only accounts you are authorised to use, and follow GitHub’s applicable terms. If you lack the legal capacity required where you live, have a parent or legal guardian review and agree to these terms and assist you with contributions.\n\nSign-in links provide access to these terms and the privacy policy. Saving a draft or submitting media means you agree to these terms. The privacy policy describes data processing; it is not a separate marketing consent or content licence.",
            },
            {
              id: "uploads",
              title: "3. Contributions and rights",
              body: "You keep your rights in your work and must have permission to upload it, allow moderation, and publish it under the stated licence. Third-party images, music, likenesses, voices, trademarks, and other protected material may require additional permission. Availability online does not mean permission to redistribute.\n\nBy saving or submitting, you permit the operator to store EV3 output, generate previews, and process moderation and security checks to operate the service. Only approved, published entries are available for public preview and download. Do not include private personal information, confidential material, keys, or credentials in media or descriptions.",
            },
            {
              id: "license",
              title: "4. Public media: CC BY 4.0",
              body: "Before submitting, you must confirm your sharing rights and agree to publication under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/) after approval. The licence permits redistribution, adaptation and commercial use. Reusers must give appropriate credit, link the licence and identify changes, without implying endorsement or adding restrictions on permitted uses.\n\nLicences already granted cannot be revoked while their terms are followed. Withdrawal cannot recall lawful copies or permissions already received. Privacy, publicity, trademark and other rights may still affect a particular use. The [full CC BY 4.0 legal code](https://creativecommons.org/licenses/by/4.0/legalcode) governs. Saving a draft or an unpublished submission does not make it publicly licensed through the Gallery.",
            },
            {
              id: "conduct",
              title: "5. Prohibited conduct",
              body: "Do not contribute material that infringes copyright, privacy or other rights, or illegal, threatening, harassing, hateful, sexually exploitative or other material unsuitable for a public educational community. Do not distribute malicious files, impersonate others, evade review or quotas, attempt unauthorised access, or disrupt the service with abusive requests.\n\nSupported formats, sizes and submission limits are displayed in the contribution interface. Do not bypass them to use unsupported files or purposes.",
            },
            {
              id: "moderation",
              title: "6. Moderation, withdrawal and appeals",
              body: "Administrators may reject or remove media because of rights concerns, violations, file problems or service operations. Review results and reasons are shown in My works. Approval is not a guarantee that media is free of third-party rights. Authors can withdraw pending or published work; changes require another review and authors cannot approve their own publication through author permissions.\n\nWithdrawal stops public access on this website. It does not automatically delete accounts, files or moderation records. See the [privacy policy](/privacy#retention) for retention and deletion requests.",
            },
            {
              id: "reports",
              title: "7. Reports and contact",
              body: `Email ${contact} with the entry URL, a description of the issue, the rights you assert or your relationship to the work, and a reply address. The operator may request reasonable additional information to verify the request and may restrict access, contact the contributor or correct a moderation decision. Do not send passwords, keys or unnecessary identity documents, or post sensitive information in a public GitHub issue.`,
            },
            {
              id: "availability",
              title: "8. Availability and responsibility",
              body: "The service and media are provided as available and may change or be interrupted for maintenance, security, resource limitations or other reasons. Keep your original files and backups. Check that media is suitable for your EV3 device, program and use case.\n\nTo the extent permitted by applicable law, the operator does not guarantee uninterrupted service, fitness for a particular purpose or error-free media. These terms do not exclude liability that cannot lawfully be excluded or affect mandatory rights you have under applicable law.",
            },
            {
              id: "changes",
              title: "9. Changes to these terms",
              body: "This page displays its update date. Material changes affecting contributions or data use will be highlighted at relevant website entry points, with renewed agreement where required by law or the nature of the change. Changes do not retrospectively revoke existing CC BY 4.0 licences. Traditional Chinese and English versions are intended to describe the same rules; contact the operator if you find a translation difference.",
            },
          ],
        };
  return zh
    ? {
        title: "隱私政策",
        intro:
          "本政策說明 Kobrixa 網站與 Gallery 目前如何處理資料，並區分瀏覽器內的素材轉換與送到伺服器的投稿。",
        sections: [
          {
            id: "operator",
            title: "1. 適用範圍與聯絡",
            body: `本政策適用於 kobrixa.com 及提供相同網站的官方 Worker 網址，由 ${LEGAL_OPERATOR} 維護。隱私、資料查詢、更正、刪除及侵權相關申請請寄至 ${contact}。桌面軟體與你另行使用的 GitHub 或其他第三方服務，仍適用其各自的文件與政策。`,
          },
          {
            id: "data",
            title: "2. 我們處理哪些資料",
            body: "- **登入資料**：GitHub 數字 ID 與使用者名稱。伺服器會暫時使用 OAuth 授權碼及存取權杖取得公開帳號資料；不將 GitHub 存取權杖存入資料庫，也不索取 GitHub 密碼、私人儲存庫或電子郵件讀取權限。\n- **工作階段資料**：登入工作階段的雜湊憑證、帳號關聯及到期時間；登入過程另有一次性驗證狀態與 PKCE 驗證資料。\n- **投稿資料**：作品標題、說明、EV3 成品、檔案順序與大小、尺寸或時長、作者識別資料、作品狀態、版本及時間。送審前會要求確認分享權利及授權。\n- **維運紀錄**：上傳批次、審核者、決定、理由及時間，用於限額、防止濫用與處理申訴。網站的託管及安全服務也會處理連線、請求、錯誤或安全紀錄，例如 IP 位址、請求路徑、時間與瀏覽器資訊。\n- **你主動提供的聯絡資料**：處理詢問或申訴時，會使用來信內容、回覆地址及你提供的必要證明。",
          },
          {
            id: "local",
            title: "3. 原始素材與瀏覽器處理",
            body: "圖片裁切、音訊解碼及轉換在瀏覽器內執行。選取原始 PNG、JPEG、WebP、MP3、WAV 或 OGG 並不會把原始檔上傳至 Gallery；按下儲存草稿或送審後，伺服器接收 EV3 成品及作品欄位。匯入既有 RGF／RSF 時，該檔案本身就是將上傳的成品。\n\n成品仍可能包含可辨識的人像、聲音或其他個人資料；轉換格式不等於匿名化。預覽及試聽由已驗證的成品產生。",
          },
          {
            id: "purposes",
            title: "4. 使用目的與公開範圍",
            body: "資料用於驗證登入、保存及展示作品、審核、產生預覽與下載、執行投稿限額、維持安全及回覆申請。我們不將投稿資料作為廣告行銷名單，也不出售你的投稿或帳號資料。\n\n已公開作品的成品、標題、說明、GitHub 作者名稱與識別資訊、授權、尺寸／時長及作品時間等資料，可由任何人透過頁面或 API 取得，也可能被搜尋引擎收錄。請只填寫你願意公開的資料。非公開作品僅允許作者及管理員透過服務存取；提供託管的服務商亦可能為提供服務或依法處理資料。\n\n公開下載者可以依授權保存及散布素材。撤下作品不會刪除他人的下載、搜尋快取或外部副本。",
          },
          {
            id: "storage",
            title: "5. Cookie 與本機儲存",
            body: "| 項目 | 用途 | 期限 |\n| --- | --- | --- |\n| `__Host-kobrixa-session` | 維持 Gallery 登入，HttpOnly／Secure／SameSite=Lax | 7 天；登出時撤銷目前工作階段 |\n| `__Host-kobrixa-oauth` | 保護 GitHub 登入流程 | 最長 10 分鐘；登入回呼後清除 |\n| `kobrixa-locale`（localStorage） | 記住繁中／英文選擇 | 直到你清除網站儲存資料 |\n\n路由功能亦可能在 sessionStorage 保存分頁的捲動位置，通常隨瀏覽器分頁工作階段結束而清除。網站程式未加入廣告 Cookie 或行銷追蹤 SDK。你可在瀏覽器清除或封鎖儲存資料；封鎖必要 Cookie 會使登入與投稿無法正常運作。",
          },
          {
            id: "providers",
            title: "6. 外部服務與跨境處理",
            body: "- **Cloudflare** 提供網站、Worker、D1 資料庫與 R2 檔案儲存，以及網路、安全與維運處理；資料可能在你所在地以外處理。[Cloudflare 隱私政策](https://www.cloudflare.com/privacypolicy/)。\n- **GitHub** 提供登入驗證，會接收登入及授權請求。本服務只要求公開帳號資訊所需的基本存取；網站不取得你的 GitHub 密碼。[GitHub 隱私聲明](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)。\n- **Google Fonts** 提供網站字型。瀏覽器會連至 Google 的字型網域，因此該服務會接收載入字型所需的連線與請求資訊（包含 IP 位址及瀏覽器資訊）。[Google 隱私政策](https://policies.google.com/privacy)。\n\n開啟其他外部連結或透過電子郵件聯絡時，相關服務商亦會依其政策處理資料。除提供服務、處理權利申請、安全事件或法律要求等必要情形外，不另行對外提供非公開投稿資料。",
          },
          {
            id: "retention",
            title: "7. 保存期限與刪除",
            body: "登入工作階段 7 天到期，OAuth 驗證狀態 10 分鐘到期；過期資料由每日排程清理，實際移除可能晚於失效時間。未被作品引用且已超過 24 小時的上傳批次會進入排程清理，每次處理量有限，並非保證 24 小時內刪除。\n\n目前帳號、草稿、待審／拒絕／撤下作品、仍被作品引用的成品與審核紀錄，沒有自動刪除期限。撤下只停止公開存取；你可透過本頁聯絡方式申請刪除。營運者會核實申請並處理可刪除的資料；若因法律義務、安全、爭議或權利證明必須保留部分資料，會說明原因。\n\n服務商的維運紀錄及備份依其服務設定與保存機制輪替；刪除主要資料不保證所有備份立即消失，也無法刪除他人已合法取得的公開副本。",
          },
          {
            id: "choices",
            title: "8. 你的選擇與申請",
            body: `你可以免登入瀏覽或下載；登入後可在「我的作品」查看投稿、依作品狀態撤下或修改，並可隨時登出。你也可在 [GitHub 的應用程式設定](https://github.com/settings/applications) 撤銷 OAuth 授權；這不會自動刪除本站資料或撤銷已建立的本站工作階段，請同時登出或聯絡營運者。\n\n如需查詢、更正、取得副本、刪除資料，或提出適用法律允許的其他申請，請寄信至 ${contact}，提供 GitHub 使用者名稱、相關作品網址及申請內容。僅會要求合理、必要的身分確認資訊，請勿提供密碼或不必要的證件。依法不能限制的申訴或向主管機關反映的權利不受本政策影響。`,
          },
          {
            id: "safety",
            title: "9. 安全、未成年人與政策更新",
            body: "登入 Cookie 使用 HttpOnly 與 HTTPS 安全屬性，伺服器檢查權限，R2 原始儲存空間不提供公用直連。這些措施不能保證絕對安全。請勿上傳其他人的私密資料；家長或法定代理人如對未成年人的投稿或資料有疑慮，可使用上述聯絡方式要求協助。\n\n本頁會隨實際資料處理方式更新並標示日期。涉及新用途或重大處理方式變更時，會在相關入口提示，並在依法需要時取得額外同意。",
          },
        ],
      }
    : {
        title: "Privacy Policy",
        intro:
          "This policy describes how the Kobrixa website and Gallery currently handle data, distinguishing browser-local conversion from contributions sent to the server.",
        sections: [
          {
            id: "operator",
            title: "1. Scope and contact",
            body: `This policy covers kobrixa.com and the official Worker address serving the same website, maintained by Kobrixa project maintainer Kingsley1116. Send privacy, access, correction, deletion and rights-related requests to ${contact}. The desktop application and third-party services such as GitHub also have their own applicable documentation and policies.`,
          },
          {
            id: "data",
            title: "2. Data we process",
            body: "- **Sign-in**: your numeric GitHub ID and username. The server temporarily uses an OAuth code and access token to retrieve public account information. It does not store GitHub access tokens in the database or request your GitHub password, private-repository permissions or email-read permission.\n- **Sessions**: hashed session credentials, account associations and expiry times; one-time state and PKCE verification data are also used during sign-in.\n- **Contributions**: titles, descriptions, EV3 output, file order and sizes, dimensions or duration, author identifiers, status, version and timestamps. Sharing-rights and licence confirmation is required before submission.\n- **Operations**: upload batches and moderation actors, decisions, reasons and times, used for quotas, abuse prevention and appeals. Hosting and security services also process connection, request, error or security records, such as IP addresses, request paths, timestamps and browser information.\n- **Contact information you provide**: correspondence, reply addresses and necessary evidence supplied with enquiries or reports.",
          },
          {
            id: "local",
            title: "3. Source files and browser processing",
            body: "Image cropping, audio decoding and conversion run in your browser. Selecting a source PNG, JPEG, WebP, MP3, WAV or OGG does not upload that original to the Gallery. Saving a draft or submitting sends EV3 output and entry fields to the server. When importing existing RGF/RSF files, those files are themselves the output uploaded.\n\nOutput may still contain identifiable faces, voices or other personal information. Conversion is not anonymisation. Previews are generated from validated output files.",
          },
          {
            id: "purposes",
            title: "4. Purposes and public visibility",
            body: "We use data to authenticate users, save and display work, moderate submissions, generate previews and downloads, enforce quotas, maintain security and respond to requests. We do not use contribution data as an advertising mailing list or sell contribution or account data.\n\nPublished media, titles, descriptions, GitHub author names and identifiers, licences, dimensions/duration and entry timestamps are available to anyone through pages or APIs and may be indexed by search engines. Include only information you intend to make public. Non-public work is accessible through the service only to its author and administrators; hosting providers may also process it to provide services or meet legal obligations.\n\nDownloaders can retain and redistribute public material under its licence. Withdrawal does not erase their downloads, search caches or external copies.",
          },
          {
            id: "storage",
            title: "5. Cookies and browser storage",
            body: "| Item | Purpose | Lifetime |\n| --- | --- | --- |\n| `__Host-kobrixa-session` | Gallery sign-in; HttpOnly, Secure, SameSite=Lax | 7 days; signing out revokes the current session |\n| `__Host-kobrixa-oauth` | Protects GitHub sign-in | Up to 10 minutes; cleared after the sign-in callback |\n| `kobrixa-locale` (localStorage) | Remembers Traditional Chinese/English | Until you clear website storage |\n\nRouting may also store scroll positions in sessionStorage, normally for the browser tab session. The website code does not include advertising cookies or marketing tracking SDKs. You can clear or block storage in your browser; blocking essential cookies prevents sign-in and contributions from working properly.",
          },
          {
            id: "providers",
            title: "6. Providers and international processing",
            body: "- **Cloudflare** provides website hosting, Workers, D1 databases, R2 file storage, networking, security and operations. Data may be processed outside your location. [Cloudflare privacy policy](https://www.cloudflare.com/privacypolicy/).\n- **GitHub** handles authentication and receives sign-in and authorisation requests. We request only basic access to public account information, not your GitHub password. [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).\n- **Google Fonts** serves website fonts. Your browser connects to Google font domains, which receive connection and request information needed to serve fonts, including IP and browser information. [Google privacy policy](https://policies.google.com/privacy).\n\nExternal links and email services also process information under their own policies. We do not otherwise disclose non-public contributions except as necessary for service delivery, rights requests, security incidents or legal requirements.",
          },
          {
            id: "retention",
            title: "7. Retention and deletion",
            body: "Sessions expire after 7 days and OAuth verification states after 10 minutes. Daily jobs clean up expired records; physical deletion may occur after access expires. Upload batches older than 24 hours that are no longer referenced by an entry become eligible for scheduled cleanup. Each run is bounded, so this is not a promise of deletion within 24 hours.\n\nAccounts, drafts, pending/rejected/withdrawn entries, referenced output files and moderation records currently have no automatic deletion deadline. Withdrawal only stops public access. You can request deletion using the contact above. The operator will verify the request and remove data that can be deleted, explaining any retention needed for legal obligations, security, disputes or evidence of rights.\n\nProvider operational records and backups rotate according to service settings and retention mechanisms. Deletion from primary storage does not guarantee immediate removal from every backup and cannot erase lawful copies already obtained by others.",
          },
          {
            id: "choices",
            title: "8. Choices and requests",
            body: `You can browse and download without signing in. My works lets signed-in users view, withdraw or edit contributions as their status allows; you can sign out at any time. You can also revoke OAuth access in [GitHub application settings](https://github.com/settings/applications). Revocation does not automatically delete our data or revoke existing website sessions; also sign out here or contact the operator.\n\nFor access, correction, a copy, deletion or other requests available under applicable law, email ${contact} with your GitHub username, relevant entry URLs and request. We ask only for reasonable, necessary verification; do not send passwords or unnecessary identity documents. This policy does not limit mandatory rights to complain or contact a competent authority.`,
          },
          {
            id: "safety",
            title: "9. Security, minors and changes",
            body: "Sign-in cookies use HttpOnly and HTTPS security attributes, the server checks permissions, and R2 storage has no public direct access. These measures cannot guarantee absolute security. Do not upload other people’s private information. Parents or legal guardians with concerns about a minor’s contributions or information can contact the operator for help.\n\nWe will update this page and its date when processing changes. New purposes or material changes will be highlighted at relevant entry points, with additional consent where required by law.",
          },
        ],
      };
}
