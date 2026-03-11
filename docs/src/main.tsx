import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/site.css";
import "../styles/prism-dark.css";
import "./styles/app.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
