import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Info, X } from "lucide-react";

const AUTO_DISMISS_MS = 9000;
const EXIT_ANIMATION_MS = 200;

interface Props {
  onDismiss: () => void;
}

export function CleanupTipToast({ onDismiss }: Props): ReactElement {
  const [exiting, setExiting] = useState(false);
  // Guards against the auto-dismiss timer and the X click both calling
  // onDismiss — second call would no-op at the parent, but the local
  // setExiting + setTimeout still ran twice. One source of truth instead.
  const exitedRef = useRef(false);

  // Two-step dismiss: flip `exiting` to fade the toast out, then unmount
  // after the CSS transition completes. Lets the user see it leave instead
  // of having it pop away abruptly.
  const beginExit = (): void => {
    if (exitedRef.current) return;
    exitedRef.current = true;
    setExiting(true);
    setTimeout(onDismiss, EXIT_ANIMATION_MS);
  };

  // Mount-only. The timer captures the `onDismiss` passed at mount and
  // calls it after AUTO_DISMISS_MS via beginExit. If a caller later swaps
  // this prop for a function whose body depends on then-current parent
  // state, this effect will call the *original* one — which is correct for
  // today's only caller (a stable setter wrapper), but worth knowing if
  // you wire the toast into anything more dynamic.
  useEffect(() => {
    const t = setTimeout(beginExit, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "relative",
        borderRadius: "10px",
        padding: "11px 14px 9px",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.18)",
        opacity: exiting ? 0 : 1,
        transform: exiting ? "translateY(-4px)" : "translateY(0)",
        transition: `opacity ${EXIT_ANIMATION_MS}ms ease-out, transform ${EXIT_ANIMATION_MS}ms ease-out`,
        animation: exiting ? undefined : "sb-slide-in-up 280ms ease-out both",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={beginExit}
        aria-label="Dismiss"
        style={{
          position: "absolute",
          top: "5px",
          right: "5px",
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
          alignItems: "flex-start",
          gap: "9px",
          paddingRight: "20px",
        }}
      >
        <Info
          size={14}
          strokeWidth={2}
          color="var(--sb-c3)"
          style={{ opacity: 0.7, flexShrink: 0, marginTop: "1px" }}
        />
        <p
          style={{
            margin: 0,
            fontSize: "11px",
            lineHeight: 1.45,
            color: "var(--sb-c3)",
            opacity: 0.78,
          }}
        >
          Disconnect from the Detection menu before uninstalling Standboy.
        </p>
      </div>

      <div
        aria-hidden
        // Mirrors the closing-timer bar at the panel's top edge so users
        // pick up the same visual cue: "this is going away on its own."
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          height: "2px",
          background: "var(--sb-c2)",
          opacity: 0.6,
          animation: `sb-countdown-shrink ${AUTO_DISMISS_MS}ms linear forwards`,
        }}
      />
    </div>
  );
}
