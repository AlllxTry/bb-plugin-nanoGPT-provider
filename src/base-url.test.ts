import { describe, expect, it } from "vitest";
import { normalizeBaseUrl, NANO_GPT_DEFAULT_BASE_URL } from "./base-url.js";
import { buildCheckRequest } from "./api-key-gate.js";
import { createNanoGptClient } from "./nano-gpt-client.js";

describe("credential endpoint validation", () => {
  it.each([undefined, null, "", "  "])("defaults an empty endpoint: %s", (value) => {
    expect(normalizeBaseUrl(value)).toBe(NANO_GPT_DEFAULT_BASE_URL);
  });
  it.each(["https://example.com/v1", "http://localhost:8080/v1", "http://127.0.0.1/v1", "http://[::1]:8080/v1"])("accepts %s", (value) => {
    expect(normalizeBaseUrl(` ${value}/// `)).toBe(value);
  });
  it.each(["http://example.com/v1", "http://localhost.evil/v1", "ftp://example.com", "garbage", "https://user:password@example.com", "https://example.com?key=secret", "https://example.com/#fragment"])("rejects %s on both authenticated request paths", (value) => {
    expect(() => normalizeBaseUrl(value)).toThrow(/Base URL/);
    expect(() => createNanoGptClient({ baseUrl: value, apiKey: "test" })).toThrow(/Base URL/);
    expect(() => buildCheckRequest("test", value)).toThrow(/Base URL/);
  });
});
