import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import "./index.css";
import {
  APP_NAME,
  APP_DESCRIPTION,
  APP_TAGLINE,
  APP_VERSION,
  PRIVACY_POLICY,
  SECURITY,
  TERMS_OF_USE,
} from "../../lib/legal";

interface AppInfoProps {
  onBack?: () => void;
}

/**
 * App Info module — a first-class screen in the QuizMaster shell (reached from
 * the Home module grid). Shows the app description, privacy policy, security
 * notes and terms of use as folded, open-by-default <details> sections.
 */
export default function AppInfo({ onBack }: AppInfoProps) {
  return (
    <div className="qminfo-app">
      <div className="qminfo-shell">
        <header className="qminfo-head">
          <button type="button" className="qminfo-back" onClick={onBack} aria-label="Back to home">
            <ArrowLeft size={18} aria-hidden />
          </button>
          <div>
            <h1 className="qminfo-title">{APP_NAME} — App information</h1>
            <p className="qminfo-sub">v{APP_VERSION} · {APP_TAGLINE}</p>
          </div>
        </header>

        <p className="qminfo-lead">
          What the app is, how your data is handled, our security posture, and the terms of use.
          Each section is folded — tap a heading to expand or collapse it.
        </p>

        <div className="qminfo-docs">
          <Doc title="App description" body={APP_DESCRIPTION} />
          <Doc title="Privacy Policy" body={PRIVACY_POLICY} />
          <Doc title="Security" body={SECURITY} />
          <Doc title="Terms of Use" body={TERMS_OF_USE} />
        </div>
      </div>
    </div>
  );
}

/** One folded document inside the App Info module (open by default). */
function Doc({ title, body }: { title: string; body: ReactNode }) {
  return (
    <details className="qm-legal-doc" open>
      <summary>{title}</summary>
      <div className="qm-legal-doc-body">{body}</div>
    </details>
  );
}