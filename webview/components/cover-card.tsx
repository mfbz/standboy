import { useState } from "react";
import type { ReactElement } from "react";
import type { LibraryEntry } from "../../src/messages";

interface Props {
  entry: LibraryEntry;
  active: boolean;
  onClick: () => void;
}

export function CoverCard({ entry, active, onClick }: Props): ReactElement {
  const [imgFailed, setImgFailed] = useState(false);
  const showCover = entry.coverUri !== null && !imgFailed;
  const letter = (entry.displayName[0] ?? entry.name[0] ?? "?").toUpperCase();

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-stretch text-left"
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
      }}
    >
      <div
        className="relative overflow-hidden"
        style={{
          aspectRatio: "1 / 1",
          borderRadius: "8px",
          marginBottom: "8px",
          background: "linear-gradient(135deg, var(--sb-c1), var(--sb-c0))",
          boxShadow: active
            ? "0 0 0 2px var(--sb-c2), 0 1px 2px rgba(0,0,0,0.3), 0 8px 24px color-mix(in srgb, var(--sb-c2) 22%, transparent)"
            : "0 1px 2px rgba(0,0,0,0.3), 0 4px 12px rgba(0,0,0,0.18)",
          transition:
            "transform 200ms cubic-bezier(0.2, 0.8, 0.4, 1), box-shadow 200ms ease-out",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = "translateY(-3px) scale(1.02)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = "";
        }}
      >
        {showCover ? (
          <img
            src={entry.coverUri ?? ""}
            alt=""
            onError={() => setImgFailed(true)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
            draggable={false}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "44px",
              fontWeight: 700,
              color: "rgba(226,243,228,0.55)",
              textShadow: "0 2px 4px rgba(0,0,0,0.2)",
              letterSpacing: "-0.04em",
            }}
          >
            {letter}
          </div>
        )}

        <span
          aria-hidden
          style={{
            position: "absolute",
            top: "6px",
            right: "6px",
            background: "rgba(0,0,0,0.55)",
            color: "rgba(255,255,255,0.85)",
            fontSize: "8.5px",
            padding: "2px 6px",
            borderRadius: "3px",
            letterSpacing: "0.08em",
            fontWeight: 700,
            textTransform: "uppercase",
            backdropFilter: "blur(4px)",
          }}
        >
          {entry.ext}
        </span>
      </div>

      <span
        title={entry.displayName}
        style={{
          fontSize: "11px",
          lineHeight: 1.35,
          opacity: 0.85,
          fontWeight: 500,
          padding: "0 2px",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          textOverflow: "ellipsis",
          wordBreak: "break-word",
          color: "var(--sb-c3)",
        }}
      >
        {entry.displayName}
      </span>
    </button>
  );
}
