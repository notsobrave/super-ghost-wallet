import { isBridgeMessage, post } from "./bridge.js";

const STORAGE_KEY = "super-ghost-wallet:config";

function sendStored() {
  chrome.storage.local.get(STORAGE_KEY).then((r) => {
    if (r[STORAGE_KEY]) post("config", r[STORAGE_KEY]);
  });
}

window.addEventListener("message", (e) => {
  if (e.source !== window || !isBridgeMessage(e.data)) return;
  if (e.data.type === "get-config") sendStored();
  if (e.data.type === "persist")
    void chrome.storage.local.set({ [STORAGE_KEY]: e.data.config });
});

// Proactive push too, in case inpage's get-config raced us at document_start.
sendStored();
