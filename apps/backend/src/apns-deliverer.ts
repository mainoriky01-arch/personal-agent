import { connect } from "node:http2";
import { createSign } from "node:crypto";
import type { Channel } from "@pa/shared-types";
import type { Deliverer } from "@pa/intervention-service";

/**
 * Real APNs (token-based, HTTP/2) push deliverer (COD-10). Implements the same
 * `Deliverer` port as the in-memory `PushDeliverer` stub, so `InterventionService`
 * is unchanged. No secrets live in the repo — every credential is read from the
 * environment (see `.env.example`).
 *
 * The network send is injected (`ApnsSend`) so the payload/auth mapping is
 * unit-tested with zero network, and the stub stays the default in dev/test.
 */

export interface ApnsConfig {
  keyId: string; // APNS_KEY_ID — the p8 key's Key ID
  teamId: string; // APNS_TEAM_ID — Apple developer Team ID
  bundleId: string; // APNS_BUNDLE_ID — app bundle id → apns-topic
  deviceToken: string; // APNS_DEVICE_TOKEN — target device
  privateKey: string; // APNS_PRIVATE_KEY — the p8 EC private key (PEM)
  host: string; // APNs host (production vs sandbox)
}

/** APNs request pieces — pure output of the payload/header mapping. */
export interface ApnsRequest {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Injectable transport; the real one speaks HTTP/2 to Apple. */
export type ApnsSend = (req: ApnsRequest) => Promise<{ apnsId?: string }>;

const DEFAULT_HOST = "https://api.push.apple.com";
const REQUIRED = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID", "APNS_DEVICE_TOKEN", "APNS_PRIVATE_KEY"] as const;

/**
 * Build an `ApnsConfig` from environment variables, or return null when any
 * required one is missing (→ caller falls back to the stub). PEM newlines may be
 * provided as literal `\n` (common in single-line env files) and are restored.
 */
export function apnsConfigFromEnv(env: NodeJS.ProcessEnv): ApnsConfig | null {
  if (REQUIRED.some((k) => !env[k]?.trim())) return null;
  return {
    keyId: env.APNS_KEY_ID!.trim(),
    teamId: env.APNS_TEAM_ID!.trim(),
    bundleId: env.APNS_BUNDLE_ID!.trim(),
    deviceToken: env.APNS_DEVICE_TOKEN!.trim(),
    privateKey: env.APNS_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    host: env.APNS_HOST?.trim() || DEFAULT_HOST,
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the APNs provider-authentication JWT (ES256), signed with the p8 key.
 * `nowSec` is injected for deterministic tests. Pure given its inputs.
 */
export function buildAuthToken(config: ApnsConfig, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: nowSec }));
  const signingInput = `${header}.${claims}`;
  // ES256 JWS wants the raw R||S signature, not DER — ieee-p1363 emits that.
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key: config.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

/** Map an intervention delivery to the APNs alert payload (pure). */
export function buildApnsPayload(text: string): string {
  return JSON.stringify({
    aps: {
      alert: { body: text },
      sound: "default",
      "interruption-level": "time-sensitive", // barrage-style attention (§23.8)
    },
  });
}

/** Assemble the full APNs request (path, headers, body) — pure, no network. */
export function buildApnsRequest(
  input: { channel: Channel; text: string; sessionId: string },
  config: ApnsConfig,
  token: string,
): ApnsRequest {
  return {
    host: config.host,
    path: `/3/device/${config.deviceToken}`,
    headers: {
      ":method": "POST",
      authorization: `bearer ${token}`,
      "apns-topic": config.bundleId,
      "apns-push-type": "alert",
      "content-type": "application/json",
    },
    body: buildApnsPayload(input.text),
  };
}

/** Real HTTP/2 transport to Apple. Not exercised in tests. */
const http2Send: ApnsSend = (req) =>
  new Promise((resolve, reject) => {
    const client = connect(req.host);
    client.on("error", reject);
    const { ":method": method, ...headers } = req.headers;
    const stream = client.request({ ":method": method, ":path": req.path, ...headers });
    let status = 0;
    let apnsId: string | undefined;
    stream.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
      apnsId = (h["apns-id"] as string | undefined) ?? undefined;
    });
    let data = "";
    stream.on("data", (c) => (data += c));
    stream.on("end", () => {
      client.close();
      if (status >= 200 && status < 300) resolve({ apnsId });
      else reject(new Error(`APNs ${status}: ${data || "no body"}`));
    });
    stream.on("error", (e) => {
      client.close();
      reject(e);
    });
    stream.end(req.body);
  });

export class ApnsDeliverer implements Deliverer {
  constructor(
    private readonly config: ApnsConfig,
    private readonly send: ApnsSend = http2Send,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
    private readonly log: (msg: string) => void = (m) => console.error(m), // eslint-disable-line no-console
  ) {}

  async deliver(input: { channel: Channel; text: string; sessionId: string }): Promise<{ deliveryId: string }> {
    try {
      const token = buildAuthToken(this.config, this.nowSec());
      const req = buildApnsRequest(input, this.config, token);
      const { apnsId } = await this.send(req);
      return { deliveryId: apnsId ?? `apns_${input.sessionId}` };
    } catch (e) {
      // AC-3: APNs failures are logged and swallowed so the tick never crashes;
      // the intervention is still recorded with a traceable error delivery id.
      this.log(`[apns] delivery failed for session ${input.sessionId}: ${(e as Error).message}`);
      return { deliveryId: `apns_error_${input.sessionId}` };
    }
  }
}
