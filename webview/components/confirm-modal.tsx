import { useEffect, useId, useRef } from "react";
import type { ReactElement, ReactNode } from "react";

interface Props {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  // Convention: backdrop click and Escape both invoke onCancel. Callers
  // must keep cancellation non-destructive — never wire a destructive
  // default to onCancel.
  onConfirm: () => void;
  onCancel: () => void;
}

// Matches the panel root's background expression (see app.tsx). Keeping
// the card on the same fill makes the modal read as "an elevated piece of
// the panel" rather than "a foreign tile placed on top of it" — the design
// brief is flat: same color as the surface it sits on, no gradient, just
// a shadow for elevation.
const CARD_BG = "color-mix(in srgb, var(--sb-c0) 72%, black)";

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: Props): ReactElement {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
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
        // Translucent dim so the panel content stays legible underneath —
        // the modal is a focus-puller, not a wall. Pure black at low alpha
        // works against every palette without a color-cast.
        background: "rgba(0,0,0,0.5)",
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
          background: CARD_BG,
          borderRadius: "20px",
          padding: "20px 20px 16px",
          width: "100%",
          maxWidth: "320px",
          // Shadow does the elevation work since the fill matches the
          // panel — no gradient, no border, no inset highlight.
          boxShadow:
            "0 16px 40px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.35)",
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
            marginBottom: "18px",
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

// Focus rings only — no rest-state shadows or inset highlights anywhere.
// The modal's own shadow supplies depth; buttons sit flat on the card.
const PRIMARY_FOCUS_SHADOW =
  "0 0 0 2px color-mix(in srgb, var(--sb-c2) 45%, transparent)";
const GHOST_FOCUS_SHADOW =
  "0 0 0 2px color-mix(in srgb, var(--sb-c3) 22%, transparent)";

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
        // Ghost border at 16% (rather than the 14% used in the prior pass)
        // — the card's hairline border was removed for the flat redesign,
        // and a hair more contrast here keeps Cancel visually distinct
        // from the body text against the card fill.
        border: isPrimary
          ? "none"
          : "1px solid color-mix(in srgb, var(--sb-c3) 16%, transparent)",
        padding: "7px 14px",
        borderRadius: "8px",
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        cursor: "pointer",
        boxShadow: "none",
        transition:
          "filter 150ms ease-out, background 150ms ease-out, box-shadow 150ms ease-out",
        outline: "none",
      }}
      onFocus={(e) => {
        e.currentTarget.style.boxShadow = isPrimary
          ? PRIMARY_FOCUS_SHADOW
          : GHOST_FOCUS_SHADOW;
      }}
      onBlur={(e) => {
        e.currentTarget.style.boxShadow = "none";
      }}
      onMouseEnter={(e) => {
        if (isPrimary) {
          e.currentTarget.style.filter = "brightness(1.08)";
        } else {
          e.currentTarget.style.background = "rgba(255,255,255,0.06)";
        }
      }}
      onMouseLeave={(e) => {
        if (isPrimary) {
          e.currentTarget.style.filter = "";
        } else {
          e.currentTarget.style.background = "transparent";
        }
      }}
    >
      {children}
    </button>
  );
}
