import type { AssistantModel, ModelRequest, ModelResponse } from '../src/assistant/model.js';

/** What one scripted model turn does: call tools, answer with text, or refuse. */
export type FakeReply =
  | { tools: Array<{ name: string; input: unknown }> }
  | { text: string }
  | { refusal: true };

export type Step = (request: ModelRequest) => FakeReply;

/**
 * A stand-in for the language model: replays a script, one step per request, and records
 * every request it was sent. No network, no cost, the same result every run.
 */
export class ScriptedModel implements AssistantModel {
  readonly modelId = 'scripted-fake-model';
  requests: ModelRequest[] = [];
  private steps: Step[] = [];
  private turn = 0;

  script(...steps: Step[]) {
    this.steps = steps;
    this.requests = [];
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    // Deep copy: the caller keeps appending to the same messages array after we return.
    this.requests.push(JSON.parse(JSON.stringify(request)) as ModelRequest);
    const step = this.steps.shift();
    if (!step) throw new Error('scripted model: no step left for this request');
    const reply = step(request);
    this.turn += 1;

    let content: unknown[];
    let stopReason: string;
    if ('tools' in reply) {
      content = reply.tools.map((t, i) => ({
        type: 'tool_use',
        id: `toolu_fake_${this.turn}_${i}`,
        name: t.name,
        input: t.input,
      }));
      stopReason = 'tool_use';
    } else if ('text' in reply) {
      content = [{ type: 'text', text: reply.text, citations: null }];
      stopReason = 'end_turn';
    } else {
      content = [];
      stopReason = 'refusal';
    }
    return {
      id: `msg_fake_${this.turn}`,
      type: 'message',
      role: 'assistant',
      model: this.modelId,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    } as unknown as ModelResponse;
  }

  /** Everything the model was ever shown, as one string: proves what never reached it. */
  everythingSent(): string {
    return JSON.stringify(this.requests);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolResultBody = Record<string, any>;

/** The tool results in the latest message of a request, with their JSON bodies parsed. */
export function toolResults(request: ModelRequest): Array<{ isError: boolean; body: ToolResultBody }> {
  const last = request.messages[request.messages.length - 1];
  if (!last || last.role !== 'user' || typeof last.content === 'string') return [];
  return last.content.flatMap((block) =>
    block.type === 'tool_result'
      ? [{ isError: block.is_error === true, body: JSON.parse(block.content as string) as ToolResultBody }]
      : [],
  );
}
