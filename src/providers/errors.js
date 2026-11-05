import Anthropic from "@anthropic-ai/sdk";

/**
 * Thrown by the provider chain when every configured provider failed.
 */
export class AllProvidersFailedError extends Error {
  constructor(attempts) {
    super(
      "All providers failed:\n" +
        attempts.map((a) => `  - ${a.provider}/${a.model}: ${a.error}`).join("\n"),
    );
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
  }
}

/**
 * Raised internally when the local token budget for a provider is exhausted.
 */
export class BudgetExceededError extends Error {
  constructor(used, limit) {
    super(`Token budget exceeded: used ${used} of ${limit}`);
    this.name = "BudgetExceededError";
    this.quota = true;
  }
}

/**
 * Classify an error from any provider.
 *
 *   quota      -> out of credit / rate limited / overloaded / budget: switch provider
 *   auth       -> bad or missing key: switch provider (this one can't work)
 *   unavailable-> model/endpoint not found (404): switch provider
 *   transient  -> network blip / 5xx: retry same provider a couple of times
 *   fatal      -> bad request etc: don't switch, surface it
 */
export function classifyError(err) {
  if (!err) return "fatal";
  if (err.quota) return "quota";

  // Anthropic SDK typed errors (checked most-specific first).
  if (err instanceof Anthropic.RateLimitError) return "quota";
  if (err instanceof Anthropic.OverloadedError) return "quota";
  if (err instanceof Anthropic.AuthenticationError) return "auth";
  if (err instanceof Anthropic.PermissionDeniedError) return "auth";
  if (err instanceof Anthropic.NotFoundError) return "unavailable";
  if (err instanceof Anthropic.APIConnectionError) return "transient";
  if (err instanceof Anthropic.InternalServerError) return "transient";
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402 || err.type === "billing_error") return "quota";
    // The API reports an exhausted prepaid balance as a 400 invalid_request_error.
    if (err.status === 400 && /credit balance|insufficient.*credit|quota/i.test(err.message ?? "")) return "quota";
    if (err.status === 400 && /prompt is too long|context.*length|too many tokens/i.test(err.message ?? "")) return "context";
    return "fatal";
  }

  // Generic HTTP errors from OpenAI-compatible providers.
  const status = err.status ?? err.statusCode;
  if (status === 429 || status === 402 || status === 529) return "quota";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "unavailable";
  if (status >= 500) return "transient";
  if (status === 400 && /context length|maximum context|too many tokens|token limit/i.test(err.message ?? "")) return "context";
  if (status === 400 && /insufficient_quota|billing|credit/i.test(err.message ?? "")) return "quota";
  if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ETIMEDOUT" || err.name === "FetchError" || err.cause?.code) return "transient";
  return "fatal";
}
