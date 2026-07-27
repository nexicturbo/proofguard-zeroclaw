import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  assertPublicHttpsUrl,
  canonicalManifest,
  digestManifest,
  fetchFingerprint,
  isBlockedAddress,
  parseArgs,
  prepareAttestation,
  verifyAsset,
} from "../src/proofguard.mjs";

test("argument parsing rejects missing option values", () => {
  assert.deepEqual(parseArgs(["status", "--reference", "abc"]), {
    command: "status",
    options: { reference: "abc" },
  });
  assert.throws(() => parseArgs(["attest", "--url"]), /Missing value/);
});

test("private and special-purpose address ranges are blocked", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "::1",
    "::ffff:172.16.0.1",
    "2001:db8::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress("1.1.1.1"), false);
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
});

test("URL gate requires HTTPS and rejects blocked DNS answers", async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl("http://example.com/a", async () => []),
    /Only public HTTPS/,
  );
  await assert.rejects(
    () =>
      assertPublicHttpsUrl("https://example.com/a", async () => [
        { address: "127.0.0.1", family: 4 },
      ]),
    /blocked address space/,
  );
  const result = await assertPublicHttpsUrl("https://example.com/a", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  assert.equal(result.hostname, "example.com");
});

test("redirects are revalidated and capped", async () => {
  let calls = 0;
  const redirectingFetch = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: `https://example.com/redirect-${calls}` },
    });
  };

  await assert.rejects(
    () =>
      fetchFingerprint("https://example.com/start", {
        fetchImpl: redirectingFetch,
        lookup: publicLookup,
        maxRedirects: 2,
      }),
    /redirect limit/,
  );
  assert.equal(calls, 3);
});

function fixtureFetch(bytes, headers = {}) {
  return async () =>
    new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": String(bytes.length),
        ...headers,
      },
    });
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("fingerprint and verify are deterministic", async () => {
  const bytes = Buffer.from("proofguard-fixture");
  const options = { fetchImpl: fixtureFetch(bytes), lookup: publicLookup };
  const fingerprint = await fetchFingerprint("https://example.com/asset.png", options);
  assert.equal(fingerprint.sha256, "ba6ba11763ed979f41a28f9678e3f6b0b96ca8001f8fcb8b3cb2bbb8312c7691");
  const verified = await verifyAsset({
    url: "https://example.com/asset.png",
    expected: fingerprint.sha256,
    fingerprintOptions: options,
  });
  assert.equal(verified.result, "MATCH");
});

test("manifest digest is stable for the same canonical input", () => {
  const manifest = canonicalManifest({
    fingerprint: {
      url: "https://example.com/asset.png",
      sha256: "a".repeat(64),
      bytes: 42,
      contentType: "image/png",
    },
    creator: "11111111111111111111111111111111",
    createdAt: "2026-07-27T00:00:00.000Z",
  });
  assert.equal(digestManifest(manifest), digestManifest({ ...manifest }));
});

test("attestation builder produces an unsigned transaction and reference", async () => {
  const bytes = Buffer.from("proofguard-fixture");
  const connection = {
    getLatestBlockhash: async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 123,
    }),
  };
  const result = await prepareAttestation({
    url: "https://example.com/asset.png",
    wallet: "11111111111111111111111111111111",
    connection,
    now: () => "2026-07-27T00:00:00.000Z",
    fingerprintOptions: { fetchImpl: fixtureFetch(bytes), lookup: publicLookup },
  });

  assert.equal(result.custody, "T1 Build");
  assert.equal(result.network, "devnet");
  assert.ok(result.transactionBase64.length > 100);
  assert.doesNotThrow(() => new PublicKey(result.reference));
  assert.match(result.memo, /^proofguard:v1:[a-f0-9]{64}$/);
});
