import type { ReactElement } from "react";
import { Zap, X } from "lucide-react";
import type { Agent } from "../../src/messages";

const AGENT_LABEL: Record<Agent, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
};

interface Props {
  agents: Agent[];
  onConnect: (agent: Agent) => void;
  onDismiss: () => void;
}

export function ConnectCta({
  agents,
  onConnect,
  onDismiss,
}: Props): ReactElement | null {
  if (agents.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Auto-show onboarding"
      style={{
        position: "relative",
        borderRadius: "10px",
        padding: "12px 14px 13px",
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--sb-c2) 9%, transparent), color-mix(in srgb, var(--sb-c2) 3%, transparent))",
        border: "1px solid color-mix(in srgb, var(--sb-c2) 28%, transparent)",
        boxShadow:
          "0 1px 2px rgba(0,0,0,0.2), 0 4px 14px color-mix(in srgb, var(--sb-c2) 10%, transparent)",
        animation: "sb-slide-in-up 280ms ease-out both",
      }}
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          position: "absolute",
          top: "6px",
          right: "6px",
          width: "22px",
          height: "22px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "5px",
          background: "transparent",
          border: "none",
          color: "var(--sb-c3)",
          opacity: 0.45,
          cursor: "pointer",
          transition: "opacity 150ms ease-out, background 150ms ease-out",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = "0.85";
          e.currentTarget.style.background = "rgba(255,255,255,0.07)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = "0.45";
          e.currentTarget.style.background = "transparent";
        }}
      >
        <X size={13} strokeWidth={2.25} />
      </button>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          paddingRight: "20px",
          marginBottom: "4px",
        }}
      >
        <Zap
          size={14}
          strokeWidth={2.25}
          color="var(--sb-c2)"
          fill="var(--sb-c2)"
        />
        <span
          style={{
            fontSize: "12px",
            fontWeight: 600,
            letterSpacing: "-0.005em",
            color: "var(--sb-c3)",
          }}
        >
          Auto-show during AI activity
        </span>
      </div>

      <p
        style={{
          margin: 0,
          fontSize: "11px",
          lineHeight: 1.45,
          opacity: 0.62,
          color: "var(--sb-c3)",
          paddingRight: "4px",
        }}
      >
        Connect your agent and Standboy will expand this panel while it's
        generating.
      </p>

      <div
        style={{
          display: "flex",
          gap: "8px",
          marginTop: "10px",
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        {agents.map((agent) => (
          <AgentButton
            key={agent}
            label={`Connect ${AGENT_LABEL[agent]}`}
            onClick={() => onConnect(agent)}
          />
        ))}
      </div>
    </div>
  );
}

function AgentButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "var(--sb-c2)",
        color: "var(--sb-c0)",
        border: "none",
        padding: "6px 12px",
        borderRadius: "6px",
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.04em",
        cursor: "pointer",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.15) inset, 0 1px 2px rgba(0,0,0,0.2)",
        transition: "transform 150ms ease-out, filter 150ms ease-out",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.filter = "brightness(1.08)";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = "";
        e.currentTarget.style.transform = "";
      }}
    >
      {label}
    </button>
  );
}
