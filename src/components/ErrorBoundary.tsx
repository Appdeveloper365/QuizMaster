import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Called when the user requests a reset after an error (e.g. go back home). */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

/** Catches runtime errors anywhere in the tree so a crash in one module never
 *  blanks the whole app. Resets when the `key` changes or the user taps reset. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("QuizMaster error boundary:", error, info);
  }

  handleReset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#10131b",
          color: "#e5e7eb",
          fontFamily: "Inter, system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: "#9ca3af", marginBottom: 20, whiteSpace: "pre-wrap" }}>
            {this.state.error.message || this.state.error.name}
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={this.handleReset}
              style={buttonStyle("#8b5cf6", "#ede9fe")}
            >
              Try again
            </button>
            <button
              onClick={this.handleReset}
              style={buttonStyle("rgba(255,255,255,0.12)", "#e5e7eb")}
            >
              Back to home
            </button>
          </div>
        </div>
      </div>
    );
  }
}

function buttonStyle(bg: string, color: string): React.CSSProperties {
  return {
    background: bg,
    color,
    border: "none",
    borderRadius: 999,
    padding: "10px 18px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  };
}