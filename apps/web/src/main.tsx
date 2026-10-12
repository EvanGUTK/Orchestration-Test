import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createAppServices, safeLocalStorage } from "./app/create-services.js";
import { loadLocalEngine } from "./game/local-engine.js";
import "./styles/tokens.css";
import "./styles/app.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

const services = createAppServices({ engine: loadLocalEngine(), storage: safeLocalStorage() });

createRoot(root).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
