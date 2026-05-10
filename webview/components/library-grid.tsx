import type { ReactElement } from "react";
import { Plus } from "lucide-react";
import { CoverCard } from "./cover-card";
import type { LibraryEntry } from "../../src/messages";

interface Props {
  entries: LibraryEntry[];
  currentHash: string | null;
  onSwitchRom: (hash: string) => void;
  onAddRom: () => void;
}

export function LibraryGrid({
  entries,
  currentHash,
  onSwitchRom,
  onAddRom,
}: Props): ReactElement {
  return (
    <div
      style={{
        padding: "18px 14px 20px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "12px",
        overflowY: "auto",
        flex: 1,
        minHeight: 0,
      }}
    >
      {entries.map((e) => (
        <CoverCard
          key={e.hash}
          entry={e}
          active={e.hash === currentHash}
          onClick={() => onSwitchRom(e.hash)}
        />
      ))}
      <AddTile onClick={onAddRom} />
    </div>
  );
}

function AddTile({ onClick }: { onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Add ROM"
      className="group"
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        textAlign: "center",
      }}
      onMouseEnter={(e) => {
        const tile = e.currentTarget.firstElementChild as HTMLElement;
        tile.style.borderColor = "var(--sb-c2)";
        tile.style.borderStyle = "solid";
        tile.style.color = "var(--sb-c2)";
        tile.style.background = "rgba(148,227,68,0.06)";
        tile.style.boxShadow =
          "0 0 0 1px rgba(148,227,68,0.3), 0 8px 20px rgba(148,227,68,0.12)";
        tile.style.transform = "translateY(-2px)";
      }}
      onMouseLeave={(e) => {
        const tile = e.currentTarget.firstElementChild as HTMLElement;
        tile.style.borderColor = "rgba(226,243,228,0.18)";
        tile.style.borderStyle = "dashed";
        tile.style.color = "rgba(226,243,228,0.45)";
        tile.style.background = "rgba(255,255,255,0.015)";
        tile.style.boxShadow = "";
        tile.style.transform = "";
      }}
    >
      <div
        style={{
          aspectRatio: "1 / 1",
          borderRadius: "8px",
          border: "1.5px dashed rgba(226,243,228,0.18)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(226,243,228,0.45)",
          background: "rgba(255,255,255,0.015)",
          marginBottom: "8px",
          transition: "all 200ms ease-out",
        }}
      >
        <Plus size={26} strokeWidth={1.5} />
      </div>
      <span
        style={{
          fontSize: "10px",
          opacity: 0.5,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          fontWeight: 600,
          padding: "0 2px",
          color: "var(--sb-c3)",
        }}
      >
        Add ROM
      </span>
    </button>
  );
}
