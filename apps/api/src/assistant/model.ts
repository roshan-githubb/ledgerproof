import Anthropic from '@anthropic-ai/sdk';

export type ModelRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type ModelResponse = Anthropic.Beta.Messages.BetaMessage;

/**
 * The one seam between the assistant and the language model. Production uses the Anthropic
 * API; tests use a scripted fake, so every safety rule is tested without network or cost.
 */
export interface AssistantModel {
  readonly modelId: string;
  create(request: ModelRequest): Promise<ModelResponse>;
}

export const DEFAULT_ASSISTANT_MODEL = 'claude-opus-5-5';

/** Credentials come from the environment (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN). */
export function anthropicModel(modelId: string = DEFAULT_ASSISTANT_MODEL): AssistantModel {
  const client = new Anthropic();
  return {
    modelId,
    create: (request) => client.beta.messages.create(request),
  };
}
