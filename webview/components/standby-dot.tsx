import type { ReactElement } from "react";
import type { ActivityState } from "../../src/messages";

interface Props {
  state: ActivityState;
}

export function StandbyDot({ state }: Props): ReactElement {
  const active = state === "active";
  return (
    <span
      aria-label={active ? "Active" : "Idle"}
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{
        background: active ? "var(--sb-c2)" : "var(--sb-c1)",
        boxShadow: active ? "0 0 8px var(--sb-c2)" : "none",
        transition: "background 200ms ease-out, box-shadow 200ms ease-out",
      }}
    />
  );
}
