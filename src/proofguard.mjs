import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Agent, fetch as undiciFetch } from "undici";

export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

const DEVNET_EXPLORER = "https://explorer.solana.com";
const DEFAULT_RPC = clusterApiUrl("devnet");

function json(value) {
  return JSON.stringify(value);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      throw new Error(`Unexpected argument: ${item}`);
    }
    const key = item.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }

  return { command, options };
}

function isBlockedIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fec") ||
    normalized.startsWith("fed") ||
    normalized.startsWith("fee") ||
    normalized.startsWith("fef") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

async function resolvePublicHttpsUrl(rawUrl, lookup = dns.lookup) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Asset URL is invalid");
  }

  if (url.protocol !== "https:") {
    throw new Error("Only public HTTPS asset URLs are accepted");
  }
  if (url.username || url.password) {
    throw new Error("Credential-bearing URLs are not accepted");
  }

  const results = await lookup(url.hostname, { all: true, verbatim: true });
  if (!results.length || results.some(({ address }) => isBlockedAddress(address))) {
    throw new Error("Asset host resolves to blocked address space");
  }
  return { url, addresses: results };
}

export async function assertPublicHttpsUrl(rawUrl, lookup = dns.lookup) {
  return (await resolvePublicHttpsUrl(rawUrl, lookup)).url;
}

function pinnedDispatcher(addresses) {
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        const requestedFamily = Number(options?.family || 0);
        const eligible = addresses.filter(
          ({ family }) => !requestedFamily || family === requestedFamily,
        );
        if (options?.all) {
          callback(null, eligible.length ? eligible : addresses);
          return;
        }
        const selected = eligible[0] || addresses[0];
        callback(null, selected.address, selected.family);
      },
    },
  });
}

async function readLimitedBody(response, maxBytes = MAX_ASSET_BYTES) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    throw new Error(`Asset exceeds ${maxBytes} byte limit`);
  }
  if (!response.body) {
    throw new Error("Asset response has no body");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`Asset exceeds ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

export async function fetchFingerprint(
  rawUrl,
  {
    fetchImpl = undiciFetch,
    lookup = dns.lookup,
    maxBytes = MAX_ASSET_BYTES,
    timeoutMs = 15_000,
    maxRedirects = MAX_REDIRECTS,
    redirectCount = 0,
  } = {},
) {
  const { url, addresses } = await resolvePublicHttpsUrl(rawUrl, lookup);
  const dispatcher = fetchImpl === undiciFetch ? pinnedDispatcher(addresses) : null;
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "ProofGuard/0.1 (+https://github.com/nexicturbo/proofguard-zeroclaw)",
      },
      ...(dispatcher ? { dispatcher } : {}),
    });

    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= maxRedirects) {
        throw new Error(`Asset exceeded ${maxRedirects} redirect limit`);
      }
      const location = response.headers.get("location");
      if (!location) throw new Error("Asset redirect is missing a location");
      const nextUrl = new URL(location, url);
      return await fetchFingerprint(nextUrl.href, {
        fetchImpl,
        lookup,
        maxBytes,
        timeoutMs,
        maxRedirects,
        redirectCount: redirectCount + 1,
      });
    }
    if (!response.ok) {
      throw new Error(`Asset fetch failed with HTTP ${response.status}`);
    }

    const bytes = await readLimitedBody(response, maxBytes);
    return {
      url: url.href,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      contentType:
        response.headers.get("content-type")?.split(";")[0]?.trim() ||
        "application/octet-stream",
    };
  } finally {
    await dispatcher?.close();
  }
}

export function canonicalManifest({ fingerprint, creator, createdAt }) {
  return {
    schema: "proofguard/1",
    asset_url: fingerprint.url,
    sha256: fingerprint.sha256,
    bytes: fingerprint.bytes,
    content_type: fingerprint.contentType,
    created_at: createdAt,
    creator,
    network: "solana:devnet",
  };
}

export function digestManifest(manifest) {
  return crypto.createHash("sha256").update(json(manifest)).digest("hex");
}

export async function prepareAttestation({
  url,
  wallet,
  connection = new Connection(process.env.SOLANA_RPC_URL || DEFAULT_RPC, "confirmed"),
  now = () => new Date().toISOString(),
  fingerprintOptions,
}) {
  const creator = new PublicKey(wallet);
  const fingerprint = await fetchFingerprint(url, fingerprintOptions);
  const createdAt = now();
  const manifest = canonicalManifest({ fingerprint, creator: creator.toBase58(), createdAt });
  const manifestDigest = digestManifest(manifest);
  const reference = Keypair.generate().publicKey;
  const memo = `proofguard:v1:${manifestDigest}`;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

  const instruction = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: false },
      { pubkey: reference, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(memo, "utf8"),
  });
  const transaction = new Transaction({
    feePayer: creator,
    recentBlockhash: blockhash,
  }).add(instruction);
  const serialized = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    ok: true,
    operation: "attest",
    custody: "T1 Build",
    network: "devnet",
    asset: fingerprint,
    manifest,
    manifestDigest,
    memo,
    reference: reference.toBase58(),
    transactionBase64: serialized.toString("base64"),
    lastValidBlockHeight,
    warning: "Unsigned transaction. Inspect and approve it in a human-controlled wallet.",
  };
}

export async function verifyAsset({ url, expected, fingerprintOptions }) {
  if (!/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error("Expected SHA-256 must be 64 hexadecimal characters");
  }
  const fingerprint = await fetchFingerprint(url, fingerprintOptions);
  const match = crypto.timingSafeEqual(
    Buffer.from(fingerprint.sha256, "hex"),
    Buffer.from(expected.toLowerCase(), "hex"),
  );
  return {
    ok: true,
    operation: "verify",
    result: match ? "MATCH" : "MISMATCH",
    expected: expected.toLowerCase(),
    observed: fingerprint.sha256,
    bytes: fingerprint.bytes,
    contentType: fingerprint.contentType,
    url: fingerprint.url,
  };
}

export async function checkStatus({
  reference,
  connection = new Connection(process.env.SOLANA_RPC_URL || DEFAULT_RPC, "confirmed"),
}) {
  const publicKey = new PublicKey(reference);
  const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 1 }, "confirmed");
  if (!signatures.length) {
    return {
      ok: true,
      operation: "status",
      status: "NOT_OBSERVED",
      reference: publicKey.toBase58(),
      network: "devnet",
    };
  }
  const signature = signatures[0];
  return {
    ok: true,
    operation: "status",
    status: signature.err ? "FAILED" : signature.confirmationStatus || "processed",
    reference: publicKey.toBase58(),
    signature: signature.signature,
    blockTime: signature.blockTime,
    explorerUrl: `${DEVNET_EXPLORER}/tx/${signature.signature}?cluster=devnet`,
  };
}

async function runCli() {
  const { command, options } = parseArgs(process.argv.slice(2));
  let result;

  if (command === "attest") {
    if (!options.url || !options.wallet) {
      throw new Error("Usage: attest --url <HTTPS_URL> --wallet <SOLANA_PUBLIC_KEY>");
    }
    result = await prepareAttestation({ url: options.url, wallet: options.wallet });
  } else if (command === "verify") {
    if (!options.url || !options.expected) {
      throw new Error("Usage: verify --url <HTTPS_URL> --expected <SHA256_HEX>");
    }
    result = await verifyAsset({ url: options.url, expected: options.expected });
  } else if (command === "status") {
    if (!options.reference) {
      throw new Error("Usage: status --reference <SOLANA_PUBLIC_KEY>");
    }
    result = await checkStatus({ reference: options.reference });
  } else {
    throw new Error("Command must be one of: attest, verify, status");
  }

  process.stdout.write(`${json(result)}\n`);
}

const invokedAsScript =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (invokedAsScript) {
  runCli().catch((error) => {
    process.stdout.write(
      `${json({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  });
}
