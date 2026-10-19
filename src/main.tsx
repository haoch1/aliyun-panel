import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme";
import { TooltipProvider } from "./components/ui/Tooltip";
import "./styles/tokens.css";
import "./styles/foundation.css";
import "./styles/controls.css";
import "./styles/layout.css";
import "./styles/views.css";
import "./styles/traffic.css";
import "./styles/loading.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={400} skipDelayDuration={100}>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
