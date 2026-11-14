import { useState } from "react";
import { Settings, X, Check } from "lucide-react";
import {
  APP_NAME,
  APP_DESCRIPTION,
  APP_TAGLINE,
  APP_VERSION,
  PRIVACY_POLICY,
  SECURITY,
  TERMS_OF_USE,
} from "../lib/legal";

/**
 * LegalGear — a self-contained "folded HTML gear".
 *
 * A settings gear (⚙️) button folds out an overlay panel containing four
 * individually foldable documents (<details>): App description / Privacy
 * Policy / Security / Terms of Use. Manages its own open state so any screen
 * can drop it in with a single `<LegalGear />` and no wiring.
 */
export default function LegalGear() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* In-flow trigger under the page content — part of the layout, so it is
          always visible even if a floating element gets clipped by a preview. */}
      <div className="quiz-legal-row">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          className="qm-legal-trigger"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderRadius: 999,
            border: "1px solid rgba(217, 255, 99, 0.4)",
            background: "rgba(255, 255, 255, 0.05)",
            color: "#d9ff63",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          <Settings size={16} aria-hidden />
          <span>App info, Privacy, Security &amp; Terms</span>
        </button>
      </div>

      {/* Fixed gear for quick access from anywhere on the page. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${APP_NAME} — app info, privacy, security & terms`}
        aria-haspopup="dialog"
        className="qm-legal-gear"
      >
        <Settings size={20} aria-hidden />
      </button>

      {/* Folded panel — renders only when open. */}
      {open && (
        <div
          className="qm-legal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="legal-title"
          onClick={() => setOpen(false)}
        >
          <div className="qm-legal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="qm-legal-head">
              <div className="qm-legal-title">
                <Check size={18} aria-hidden />
                <h2 id="legal-title">{APP_NAME} — App information</h2>
              </div>
              <button type="button" className="qm-legal-close" onClick={() => setOpen(false)} aria-label="Close">
                <X size={18} aria-hidden />
              </button>
            </div>

            {/* ── Each document is its own folded <details> block ── */}
            <div className="qm-legal-docs">
              <LegalDoc title="App description" body={APP_DESCRIPTION} />
              <LegalDoc title="Privacy Policy" body={PRIVACY_POLICY} />
              <LegalDoc title="Security" body={SECURITY} />
              <LegalDoc title="Terms of Use" body={TERMS_OF_USE} />
            </div>

            <p className="qm-legal-foot">
              {APP_NAME} v{APP_VERSION} · {APP_TAGLINE} · Stored on your device only
            </p>
          </div>
        </div>
      )}
    </>
  );
}

interface LegalDocProps {
  title: string;
  body: string;
}

/** One folded document inside the gear panel (open by default; still collapsible). */
function LegalDoc({ title, body }: LegalDocProps) {
  return (
    <details className="qm-legal-doc" open>
      <summary>{title}</summary>
      {/* `body` is always a static string from src/lib/legal.ts — never user
          input — which is the only reason dangerouslySetInnerHTML is used. */}
      <div className="qm-legal-doc-body" dangerouslySetInnerHTML={{ __html: body }} />
    </details>
  );
}
