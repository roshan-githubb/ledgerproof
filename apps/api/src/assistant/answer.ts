import type Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { LedgerError } from '../errors.js';
import { findAccount } from '../ledger/accounts.js';
import { FactSheet, type Fact } from './facts.js';
import type { AssistantModel } from './model.js';
import { SYSTEM_PROMPT, rewriteInstruction } from './prompt.js';
import { ASSISTANT_TOOLS, assistantDb, runTool, type ToolContext } from './tools.js';

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type TextBlock = Anthropic.Beta.Messages.BetaTextBlock;
type ToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

/** Upper bound on model calls per question, so a confused model can't loop (and bill) forever. */
export const MAX_MODEL_TURNS = 6;
/** Chances to fix an answer that breaks the digit rule before the request fails. */
const MAX_REWRITES = 1;

export interface AnswerInput {
  tenantId: string;
  question: string;
  /** Customer-facing mode: the assistant may only see this account. */
  accountId: string | null;
}

export interface Answer {
  /** Final text, with every placeholder replaced by its value from the ledger. */
  answer: string;
  /** The facts the answer cites: where each number came from. */
  facts: Fact[];
  usage: { model_turns: number; input_tokens: number; output_tokens: number };
}

/**
 * Answers one question with the model and read-only ledger tools.
 * Design and failure analysis: docs/plans/0003-ai-assistant.md, ADR 0007.
 */
export async function answerQuestion(
  deps: { pool: pg.Pool; model: AssistantModel },
  input: AnswerInput,
): Promise<Answer> {
  let question = input.question;
  if (input.accountId !== null) {
    // 404 for an account this tenant doesn't have, before spending anything on the model.
    const account = await assistantDb(deps.pool, input.tenantId, (db) => findAccount(db, input.accountId!));
    question = `This conversation is about one account only (account_id ${account.id}); you cannot see any other account.\n\nQuestion: ${input.question}`;
  }

  const facts = new FactSheet();
  const ctx: ToolContext = {
    pool: deps.pool,
    tenantId: input.tenantId,
    scopeAccountId: input.accountId?.toLowerCase() ?? null,
    facts,
  };
  // Append-only: every model response goes back unchanged, thinking blocks included.
  const messages: MessageParam[] = [{ role: 'user', content: question }];
  const usage = { model_turns: 0, input_tokens: 0, output_tokens: 0 };
  let rewritesLeft = MAX_REWRITES;

  while (usage.model_turns < MAX_MODEL_TURNS) {
    const response = await deps.model.create({
      model: deps.model.modelId,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: ASSISTANT_TOOLS,
      messages,
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      // If a safety classifier declines, the API retries on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    usage.model_turns += 1;
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      throw new LedgerError('assistant_refused', 502, 'the assistant declined to answer this question');
    }

    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason === 'tool_use' && toolUses.length > 0) {
      const results: ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        const outcome = await runTool(call.name, call.input, ctx);
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    if (response.stop_reason === 'max_tokens') break;

    const text = response.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const check = facts.check(text);
    if (check.ok) {
      return { answer: facts.render(text), facts: facts.cited(text), usage };
    }
    if (rewritesLeft > 0) {
      rewritesLeft -= 1;
      messages.push({ role: 'user', content: rewriteInstruction(check.problems) });
      continue;
    }
    throw new LedgerError(
      'assistant_unverified_answer',
      502,
      'the assistant could not produce an answer whose numbers all come from the ledger',
    );
  }
  throw new LedgerError('assistant_gave_up', 502, 'the assistant could not finish answering this question');
}
