export class ProviderError extends Error {
  public readonly retryable: boolean;
  public readonly code: string;
  public readonly status: number | undefined;

  public constructor(message: string, options: { code: string; retryable: boolean; status?: number }) {
    super(message);
    this.name = "ProviderError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export const asProviderError = (provider: string, response: Response, body: string) =>
  new ProviderError(`${provider} request failed (${response.status}): ${body.slice(0, 500)}`, {
    code: `${provider.toUpperCase()}_${response.status}`,
    retryable: response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500,
    status: response.status,
  });
