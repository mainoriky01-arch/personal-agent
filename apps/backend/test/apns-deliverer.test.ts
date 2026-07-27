import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  ApnsDeliverer,
  apnsConfigFromEnv,
  buildApnsPayload,
  buildApnsRequest,
  buildAuthToken,
  type ApnsConfig,
  type ApnsSend,
} from "../src/apns-deliverer.js";

/**
 * COD-10 — the real APNs deliverer's mapping + auth + env-selection + error
 * handling, all with zero network: the HTTP/2 send is injected.
 */

// A throwaway P-256 keypair so ES256 signing/verification is exercised hermetically.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const config: ApnsConfig = {
  keyId: "KEY123",
  teamId: "TEAM456",
  bundleId: "com.riccardo.personalagent",
  deviceToken: "devicetoken789",
  privateKey: PEM,
  host: "https://api.push.apple.com",
};

const b64urlToJson = (seg: string) =>
  JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

describe("APNs deliverer (COD-10)", () => {
  it("maps the intervention to a time-sensitive alert payload (AC-4)", () => {
    const payload = JSON.parse(buildApnsPayload("Torna a leggere 📖"));
    expect(payload.aps.alert.body).toBe("Torna a leggere 📖");
    expect(payload.aps["interruption-level"]).toBe("time-sensitive");
  });

  it("builds the request with the device path and APNs headers (AC-1, AC-4)", () => {
    const req = buildApnsRequest({ channel: "push", text: "hey", sessionId: "s1" }, config, "TOKEN");
    expect(req.path).toBe("/3/device/devicetoken789");
    expect(req.headers["apns-topic"]).toBe("com.riccardo.personalagent");
    expect(req.headers.authorization).toBe("bearer TOKEN");
    expect(req.headers[":method"]).toBe("POST");
    expect(JSON.parse(req.body).aps.alert.body).toBe("hey");
  });

  it("signs a verifiable ES256 provider JWT (AC-1)", () => {
    const token = buildAuthToken(config, 1_700_000_000);
    const [h, c, sig] = token.split(".");
    expect(b64urlToJson(h)).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(b64urlToJson(c)).toEqual({ iss: "TEAM456", iat: 1_700_000_000 });
    const ok = createVerify("SHA256").update(`${h}.${c}`).verify(
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    );
    expect(ok).toBe(true);
  });

  it("returns the apns-id from a successful send (AC-1)", async () => {
    const send: ApnsSend = async () => ({ apnsId: "APNS-ID-1" });
    const d = new ApnsDeliverer(config, send, () => 1_700_000_000);
    const r = await d.deliver({ channel: "push", text: "hi", sessionId: "s9" });
    expect(r.deliveryId).toBe("APNS-ID-1");
  });

  it("swallows send errors, logs, and never throws (AC-3)", async () => {
    const send: ApnsSend = async () => {
      throw new Error("ECONNREFUSED");
    };
    const log = vi.fn();
    const d = new ApnsDeliverer(config, send, () => 1_700_000_000, log);
    const r = await d.deliver({ channel: "push", text: "hi", sessionId: "s9" });
    expect(r.deliveryId).toBe("apns_error_s9");
    expect(log).toHaveBeenCalledOnce();
  });

  describe("env selection (AC-2)", () => {
    const full = {
      APNS_KEY_ID: "K",
      APNS_TEAM_ID: "T",
      APNS_BUNDLE_ID: "B",
      APNS_DEVICE_TOKEN: "D",
      APNS_PRIVATE_KEY: "line1\\nline2",
    };

    it("returns null when any required var is missing → stub is used", () => {
      expect(apnsConfigFromEnv({})).toBeNull();
      expect(apnsConfigFromEnv({ ...full, APNS_DEVICE_TOKEN: "" })).toBeNull();
    });

    it("returns a config when all vars are present, restoring PEM newlines", () => {
      const c = apnsConfigFromEnv(full)!;
      expect(c).not.toBeNull();
      expect(c.privateKey).toBe("line1\nline2");
      expect(c.host).toBe("https://api.push.apple.com"); // default when APNS_HOST unset
    });
  });
});
