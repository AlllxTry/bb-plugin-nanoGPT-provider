export const NANO_GPT_DEFAULT_BASE_URL = "https://api.nano-gpt.com/api/v1";

/** Validate every endpoint before constructing requests containing credentials. */
export function normalizeBaseUrl(value: string | null | undefined): string {
  const text = value?.trim() || NANO_GPT_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Base URL must be a valid HTTPS URL (HTTP is allowed for loopback hosts only).");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (text.length > 2048 || url.username !== "" || url.password !== "" ||
      url.search !== "" || url.hash !== "" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Base URL must use HTTPS, or HTTP on localhost, 127.0.0.1 or [::1], without credentials, query or fragment.");
  }
  return url.toString().replace(/\/+$/u, "");
}
