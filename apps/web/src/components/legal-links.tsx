import { Link } from "react-router";
import "./legal-links.css";
type Translate = (zh: string, en: string) => string;
export function PolicyNotice({ t, action }: { t: Translate; action: "signin" | "save" }) {
  return (
    <p className="policy-notice">
      {action === "signin"
        ? t("登入前請閱讀", "Before signing in, read the ")
        : t("儲存草稿或送審代表你同意", "By saving a draft or submitting, you agree to the ")}{" "}
      <Link to="/terms" target="_blank" rel="noreferrer">
        {t("服務條款", "Terms of Service")}
      </Link>
      {t("；資料如何保存及公開，請參閱", "; see the ")}{" "}
      <Link to="/privacy" target="_blank" rel="noreferrer">
        {t("隱私政策", "Privacy Policy")}
      </Link>
      {t("。連結會另開分頁。", " for how data is stored and shared. Links open in a new tab.")}
    </p>
  );
}
