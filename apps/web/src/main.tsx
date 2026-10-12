import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AppProvider } from "./state/app.tsx";
import "./styles/app.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(
  <AppProvider>
    <App />
  </AppProvider>,
);
