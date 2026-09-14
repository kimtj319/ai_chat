import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "./styles/variables.css";
import "./styles/global.css";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    {/* The store is mounted by App, behind the auth gate: its bootstrap talks
        to /api and must not run before we know there is a session. */}
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
