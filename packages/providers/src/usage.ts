export type ProviderUsageSnapshot = {
  requestId?: string | undefined;
  model?: string | undefined;
  inputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  inputCharacters?: number | undefined;
  outputCharacters?: number | undefined;
};

export type ProviderResult<T> = {
  value: T;
  usage: ProviderUsageSnapshot;
};
