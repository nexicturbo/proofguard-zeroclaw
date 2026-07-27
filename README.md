# ProofGuard for ZeroClaw

ProofGuard is a self-hosted ZeroClaw use case for media provenance on Solana.
Send a public asset URL through a real webhook channel; the agent fingerprints
the bytes, prepares a canonical manifest, and builds an unsigned Solana devnet
Memo transaction. A human wallet remains the only signer.

## What it demonstrates

- A real ZeroClaw webhook channel with HMAC-authenticated inbound messages.
- A purpose-built ZeroClaw skill and focused agent identity.
- DNS-pinned SSRF protection, redirect revalidation, a five-hop redirect cap,
  and a 20 MiB fetch cap.
- SHA-256 asset fingerprints and deterministic manifest digests.
- A Solana Actions-compatible endpoint that returns an unsigned transaction.
- One-time reference keys for post-signature status checks.
- A prompt-injection boundary with no private-key or transfer capability.

Custody tier: **T1 Build**. ProofGuard never asks for, reads, stores, or uses a
private key.

## Architecture

```text
Browser dashboard
    │ HMAC POST
    ▼
ZeroClaw webhook channel ──► ProofGuard agent + skill
    │                              │
    │ reply webhook                ├─ HTTPS-only fingerprint
    ▼                              ├─ canonical manifest
Local dashboard ◄──────────────────└─ unsigned Solana Memo transaction
                                                    │
                                                    ▼
                                          human-controlled wallet
```

## Run locally

Prerequisites:

- Node.js 22.19+
- a ZeroClaw 0.8.3+ binary
- an authenticated model provider in ZeroClaw

Install and test:

```powershell
npm install
npm run check
```

Configure a ZeroClaw webhook alias named `proofguard`:

```toml
[channels.webhook.proofguard]
enabled = true
port = 8098
listen_path = "/proofguard"
secret = "proofguard-local-demo-secret-change-me"
send_url = "http://127.0.0.1:8787/api/replies"

[agents.proofguard]
channels = ["webhook.proofguard"]

[agents.proofguard.workspace]
path = "C:\\absolute\\path\\to\\proofguard-zeroclaw"
```

For a production deployment, replace the documented local demo secret, keep
the listener private or behind TLS, and store the secret through
`zeroclaw config set` so it is encrypted at rest.

Start both processes:

```powershell
npm start
zeroclaw daemon
```

Open <http://127.0.0.1:8787> and send:

```text
attest https://example.com/asset.png for wallet <SOLANA_PUBLIC_KEY>
```

The agent returns the fingerprint, manifest digest, and a safe summary. The
dashboard's Solana Action endpoint returns the full unsigned transaction for a
compatible human-controlled wallet to inspect and sign. Then:

```text
status <REFERENCE_PUBLIC_KEY>
```

## Direct CLI

```powershell
node src/proofguard.mjs attest --url "https://example.com/asset.png" --wallet "<PUBLIC_KEY>"
node src/proofguard.mjs verify --url "https://example.com/asset.png" --expected "<SHA256>"
node src/proofguard.mjs status --reference "<REFERENCE_PUBLIC_KEY>"
```

Every command emits one compact JSON object, which keeps raw RPC responses out
of the model context.

## Solana Action

The root `actions.json` maps `/api/actions/**` to itself. A compatible Action
client can request metadata and prepare a transaction with:

```text
GET  /api/actions/attest?url=<PUBLIC_HTTPS_URL>
POST /api/actions/attest?url=<PUBLIC_HTTPS_URL>
     { "account": "<SOLANA_PUBLIC_KEY>" }
```

The POST response follows the Solana Actions transaction response shape and
adds a `proof` object with the fingerprint, manifest digest, and one-time
reference. It never accepts secret-key material.

## Threat model

| Risk | Control |
|---|---|
| Prompt injection asks the agent to move funds | No signing or transfer operation exists |
| URL points at a local service | DNS answers are checked and the connection is pinned to an approved public answer |
| Redirect lands on a private host | Every redirect is revalidated; chains stop after five hops |
| Oversized response floods memory/context | Declared and streamed byte limits |
| Stale Solana blockhash | Every prepare call fetches a fresh devnet blockhash |
| Agent leaks raw RPC payloads | Commands return compact bounded JSON |
| Webhook is spoofed | HMAC-SHA256 over the exact request body |

See [PROMPT_INJECTION_TEST.md](PROMPT_INJECTION_TEST.md) for the fail-closed
attack transcript.

## License

MIT
