import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./app";

const el = document.getElementById("root");
if (!el) {
  throw new Error("Root element #root not found in document");
}

const root = createRoot(el);
root.render(<App />);
