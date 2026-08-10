import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { storage } from "./storageAdapter.js";
import App from "./App.jsx";

// The app was originally written against the artifact platform's
// window.storage API. Installing our Supabase-backed adapter under the
// same name means the app's storage code runs completely unchanged.
window.storage = storage;

// Registers the service worker that makes the site installable as an app
// ("Add to Home Screen"). Best-effort: if it fails, the site still works
// exactly the same in the browser.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
