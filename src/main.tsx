import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme";
import "./style.css";
import "./styles/reference.css";
import "./styles/traffic.css";
import "./styles/panel.css";
import "./styles/loading.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
