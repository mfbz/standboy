import { useEffect, useId, useRef } from "react";
import type { ReactElement, ReactNode } from "react";

interface Props {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  // Convention: the backdrop click and the Escape key both invoke onCancel.
  // Callers should make sure cancellation is non-destructive — never wire
  // a destructive default to onCancel.
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: Props): ReactElement {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  // Stable per-instance ids — keeps `aria-labelledby` / `aria-describedby`
  // unique if two ConfirmModals are ever stacked (currently they can't be,
  // but the cost is one hook call and it future-proofs the a11y wiring).
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    // Capture-phase listener so EmulatorJS's keydown handler on the canvas
    // can't swallow Escape, and so the modal's keys preempt the in-game
    // input handler in app.tsx (which is also registered capture-phase but
    // mounts earlier; we additionally gate it on `pendingSwitchHash` so
    // pressing Enter doesn't pulse Start on the outgoing game).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
        return;
      }
      if (e.key === "Tab") {
        // Two-element focus trap. `aria-modal="true"` promises focus stays
        // inside the dialog; without this, Tab from Confirm would escape
        // to whatever's behind the backdrop (cover cards, the panel root).
        const cancel = cancelButtonRef.current;
        const confirm = confirmButtonRef.current;
        if (!cancel || !confirm) return;
        e.preventDefault();
        const active = document.activeElement;
        if (e.shiftKey) {
          (active === confirm ? cancel : confirm).focus();
        } else {
          (active === cancel ? confirm : cancel).focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [onCancel, onConfirm]);

  useEffect(() => {
    // Focus the primary action on mount so Enter works immediately. Empty
    // deps are intentional — re-running on parent re-renders would steal
    // focus mid-Tab.
    confirmButtonRef.current?.focus();
  }, []);

  return (
    <div
      onClick={onCancel}
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "color-mix(in srgb, var(--sb-c0) 78%, black)",
        animation: "sb-backdrop-fade-in 180ms ease-out both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--sb-c1) 36%, var(--sb-c0)) 0%, var(--sb-c0) 100%)",
          border: "1px solid color-mix(in srgb, var(--sb-c3) 9%, transparent)",
          borderRadius: "12px",
          padding: "18px 18px 14px",
          width: "100%",
          maxWidth: "320px",
          boxShadow: "0 12px 32px rgba(0,0,0,0.4), 0 2px 6px rgba(0,0,0,0.3)",
          animation: "sb-modal-pop 220ms cubic-bezier(0.2, 0.8, 0.4, 1) both",
        }}
      >
        <div
          id={titleId}
          style={{
            fontSize: "13px",
            fontWeight: 600,
            letterSpacing: "-0.005em",
            color: "var(--sb-c3)",
            marginBottom: "8px",
          }}
        >
          {title}
        </div>
        <div
          id={bodyId}
          style={{
            fontSize: "11.5px",
            lineHeight: 1.5,
            color: "var(--sb-c3)",
            opacity: 0.72,
            marginBottom: "16px",
          }}
        >
          {body}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
          }}
        >
          <ModalButton
            variant="ghost"
            onClick={onCancel}
            buttonRef={cancelButtonRef}
          >
            Cancel
          </ModalButton>
          <ModalButton
            variant="primary"
            onClick={onConfirm}
            buttonRef={confirmButtonRef}
          >
            {confirmLabel}
          </ModalButton>
        </div>
      </div>
    </div>
  );
}

const PRIMARY_REST_SHADOW =
  "0 1px 0 rgba(255,255,255,0.15) inset, 0 1px 2px rgba(0,0,0,0.2)";
const PRIMARY_FOCUS_SHADOW =
  "0 0 0 2px color-mix(in srgb, var(--sb-c2) 50%, transparent), 0 1px 0 rgba(255,255,255,0.15) inset, 0 1px 2px rgba(0,0,0,0.2)";
const GHOST_FOCUS_SHADOW =
  "0 0 0 2px color-mix(in srgb, var(--sb-c3) 25%, transparent)";

function ModalButton({
  variant,
  onClick,
  buttonRef,
  children,
}: {
  variant: "primary" | "ghost";
  onClick: () => void;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}): ReactElement {
  const isPrimary = variant === "primary";
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      style={{
        background: isPrimary ? "var(--sb-c2)" : "transparent",
        color: isPrimary ? "var(--sb-c0)" : "var(--sb-c3)",
        border: isPrimary
          ? "none"
          : "1px solid color-mix(in srgb, var(--sb-c3) 14%, transparent)",
        padding: "6px 14px",
        borderRadius: "6px",
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        cursor: "pointer",
        boxShadow: isPrimary ? PRIMARY_REST_SHADOW : "none",
        transition:
          "transform 150ms ease-out, filter 150ms ease-out, background 150ms ease-out",
        outline: "none",
      }}
      onFocus={(e) => {
        e.currentTarget.style.boxShadow = isPrimary
          ? PRIMARY_FOCUS_SHADOW
          : GHOST_FOCUS_SHADOW;
      }}
      onBlur={(e) => {
        e.currentTarget.style.boxShadow = isPrimary
          ? PRIMARY_REST_SHADOW
          : "none";
      }}
      onMouseEnter={(e) => {
        if (isPrimary) {
          e.currentTarget.style.filter = "brightness(1.08)";
          e.currentTarget.style.transform = "translateY(-1px)";
        } else {
          e.currentTarget.style.background = "rgba(255,255,255,0.06)";
        }
      }}
      onMouseLeave={(e) => {
        if (isPrimary) {
          e.currentTarget.style.filter = "";
          e.currentTarget.style.transform = "";
        } else {
          e.currentTarget.style.background = "transparent";
        }
      }}
    >
      {children}
    </button>
  );
}
