import { MessageType } from "../shared/messages.js";

const planSelect = document.getElementById("plan");
const saveButton = document.getElementById("save");
const statusEl = document.getElementById("status");

await load();

saveButton.addEventListener("click", async () => {
  const plan = planSelect.value;
  const response = await chrome.runtime.sendMessage({ type: MessageType.SetPlan, plan });
  if (!response?.ok) {
    statusEl.textContent = `Error: ${response?.error || "unknown"}`;
    return;
  }

  statusEl.textContent = `Saved: ${response.result.plan}`;
});

async function load() {
  const response = await chrome.runtime.sendMessage({ type: MessageType.GetPlan });
  if (!response?.ok) {
    statusEl.textContent = "Failed to load current plan";
    return;
  }

  planSelect.value = response.result.plan;
  statusEl.textContent = `Current: ${response.result.plan}`;
}
