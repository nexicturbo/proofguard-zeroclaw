const form = document.querySelector("#chat-form");
const input = document.querySelector("#message");
const status = document.querySelector("#form-status");
const messages = document.querySelector("#messages");
const demoButton = document.querySelector("#copy-demo");
const actionForm = document.querySelector("#action-form");
const assetUrl = document.querySelector("#asset-url");
const walletAddress = document.querySelector("#wallet-address");
const actionStatus = document.querySelector("#action-status");
const actionOutput = document.querySelector("#action-output");
const copyPayload = document.querySelector("#copy-payload");
const threadId = crypto.randomUUID();
let seen = new Set();
let latestActionPayload = null;

function appendMessage(kind, content) {
  const article = document.createElement("article");
  article.className = `message ${kind}`;
  const label = document.createElement("span");
  label.textContent = kind === "agent" ? "PROOFGUARD" : "YOU";
  const paragraph = document.createElement("p");
  paragraph.textContent = content;
  article.append(label, paragraph);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
}

async function pollReplies() {
  try {
    const response = await fetch(`/api/replies?thread_id=${encodeURIComponent(threadId)}`);
    const payload = await response.json();
    for (const message of payload.messages || []) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      appendMessage("agent", message.content);
    }
  } catch {
    // The next poll retries; a transient dashboard miss is not user-visible.
  }
}

demoButton.addEventListener("click", () => {
  input.value =
    "attest https://avatars.githubusercontent.com/u/58729655?s=256 for wallet 7YttLkHDoV7G1K9JdZP2YQ3pvR8Jx6eM8xgW4tNY4nZa";
  input.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = input.value.trim();
  if (!content) return;
  appendMessage("user", content);
  input.value = "";
  status.textContent = "Dispatching through ZeroClaw…";

  try {
    const response = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: "proofguard-dashboard",
        content,
        thread_id: threadId,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Dispatch failed");
    status.textContent = "Message accepted. Waiting for the agent…";
  } catch (error) {
    status.textContent = error.message;
  }
});

actionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  actionStatus.textContent = "Fingerprinting media and building an unsigned transaction…";
  actionOutput.hidden = true;
  copyPayload.disabled = true;
  latestActionPayload = null;

  try {
    const endpoint = `/api/actions/attest?url=${encodeURIComponent(assetUrl.value.trim())}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: walletAddress.value.trim() }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "Action failed");
    latestActionPayload = payload;
    actionOutput.textContent = JSON.stringify(payload, null, 2);
    actionOutput.hidden = false;
    copyPayload.disabled = false;
    actionStatus.textContent =
      "Unsigned transaction ready. Inspect it in a compatible wallet before signing.";
  } catch (error) {
    actionStatus.textContent = error.message;
  }
});

copyPayload.addEventListener("click", async () => {
  if (!latestActionPayload) return;
  await navigator.clipboard.writeText(JSON.stringify(latestActionPayload, null, 2));
  actionStatus.textContent = "Action payload copied.";
});

setInterval(pollReplies, 1_000);
pollReplies();
