import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { required } from "../config";

export class SecretBox {
  private readonly key: Buffer;
  constructor(key = required("SETTINGS_ENCRYPTION_KEY")) {
    if (!/^[0-9a-fA-F]{64}$/.test(key))
      throw new Error("SETTINGS_ENCRYPTION_KEY must be a 32-byte hexadecimal key");
    this.key = Buffer.from(key, "hex");
  }
  encrypt(value: string, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [
      "v1",
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      ciphertext.toString("base64"),
    ].join(".");
  }
  decrypt(value: string, context: string): string {
    try {
      const [version, iv, tag, data, extra] = value.split(".");
      if (version !== "v1" || !iv || !tag || !data || extra) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(data, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Stored secret cannot be decrypted");
    }
  }
}
