import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

// Surfaces React render errors inside the panel itself. Without this,
// VSCode webviews swallow uncaught render errors and the panel just goes
// blank — and webview right-click is restricted so users can't open
// DevTools to see the cause. The ErrorBoundary doubles as a debugging
// probe and a defensive UX fallback.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error("Standboy webview error", error, info);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          height: "100%",
          padding: "20px 16px",
          overflowY: "auto",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
          color: "var(--sb-c3)",
          fontSize: "11.5px",
          lineHeight: 1.45,
        }}
      >
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            marginBottom: "10px",
            color: "var(--sb-c2)",
            letterSpacing: "-0.005em",
          }}
        >
          Standboy hit an unexpected error
        </div>
        <div style={{ opacity: 0.72, marginBottom: "14px" }}>
          The panel crashed during render. Copy the trace below into a GitHub
          issue or share it directly.
        </div>
        <pre
          style={{
            background: "rgba(0,0,0,0.35)",
            padding: "12px",
            borderRadius: "8px",
            fontSize: "10.5px",
            lineHeight: 1.4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
            fontFamily:
              "ui-monospace, 'SF Mono', Menlo, Monaco, 'Cascadia Code', monospace",
            color: "var(--sb-c3)",
            opacity: 0.85,
          }}
        >
          {this.state.error.name}: {this.state.error.message}
          {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
          {this.state.componentStack
            ? `\n\nComponent stack:${this.state.componentStack}`
            : ""}
        </pre>
      </div>
    );
  }
}
