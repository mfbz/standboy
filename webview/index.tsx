import { createRoot } from "react-dom/client";
import { App } from "./app";
import { ErrorBoundary } from "./components/error-boundary";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
