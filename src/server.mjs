import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { prepareAttestation } from "./proofguard.mjs";

const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8787);
const webhookUrl = process.env.ZEROCLAW_WEBHOOK_URL || "http://127.0.0.1:8098/proofguard";
const webhookSecret =
  process.env.ZEROCLAW_WEBHOOK_SECRET || "proofguard-local-demo-secret-change-me";
const replies = new Map();

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(root, "public")));

app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  response.setHeader("X-Blockchain-Ids", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  if (request.method === "OPTIONS") return response.sendStatus(204);
  return next();
});

function signatureFor(rawBody) {
  return crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
}

app.post("/api/send", async (request, response) => {
  const sender = String(request.body.sender || "dashboard-user").slice(0, 80);
  const content = String(request.body.content || "").trim();
  const threadId = String(request.body.thread_id || crypto.randomUUID()).slice(0, 120);
  if (!content) return response.status(400).json({ ok: false, error: "Message is required" });

  const rawBody = JSON.stringify({ sender, content, thread_id: threadId });
  const upstream = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": `sha256=${signatureFor(rawBody)}`,
    },
    body: rawBody,
  });
  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    return response.status(502).json({
      ok: false,
      error: `ZeroClaw webhook returned HTTP ${upstream.status}`,
      detail: upstreamText.slice(0, 500),
    });
  }
  return response.json({ ok: true, thread_id: threadId });
});

app.post("/api/replies", (request, response) => {
  const threadId = String(request.body.thread_id || request.body.recipient || "default");
  const entry = {
    id: crypto.randomUUID(),
    content: String(request.body.content || ""),
    receivedAt: new Date().toISOString(),
  };
  const current = replies.get(threadId) || [];
  current.push(entry);
  replies.set(threadId, current.slice(-25));
  response.json({ ok: true });
});

app.get("/api/replies", (request, response) => {
  const threadId = String(request.query.thread_id || "default");
  response.json({ ok: true, messages: replies.get(threadId) || [] });
});

app.get("/actions.json", (_request, response) => {
  response.json({
    rules: [
      {
        pathPattern: "/api/actions/attest/**",
        apiPath: "/api/actions/attest/**",
      },
    ],
  });
});

app.get("/api/actions/attest", (request, response) => {
  const assetUrl = String(request.query.url || "");
  const origin = `${request.protocol}://${request.get("host")}`;
  response.json({
    type: "action",
    icon: `${origin}/icon.svg`,
    title: "ProofGuard media attestation",
    description:
      "Fingerprint a public asset and prepare a custody-free Solana devnet memo attestation.",
    label: "Prepare attestation",
    disabled: !assetUrl,
    ...(assetUrl ? {} : { error: { message: "Add a public HTTPS asset URL." } }),
  });
});

app.post("/api/actions/attest", async (request, response) => {
  try {
    const account = String(request.body.account || "");
    const assetUrl = String(request.query.url || "");
    const result = await prepareAttestation({ url: assetUrl, wallet: account });
    response.json({
      transaction: result.transactionBase64,
      message: `Attest SHA-256 ${result.asset.sha256.slice(0, 12)}… on Solana devnet. Reference ${result.reference}.`,
      proof: {
        custody: result.custody,
        network: result.network,
        asset: result.asset,
        manifestDigest: result.manifestDigest,
        reference: result.reference,
        memo: result.memo,
        lastValidBlockHeight: result.lastValidBlockHeight,
      },
    });
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "proofguard-dashboard",
    webhookUrl,
    custody: "T1 Build",
  });
});

app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`ProofGuard dashboard: http://127.0.0.1:${port}\n`);
});
