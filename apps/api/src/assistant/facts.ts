/**
 * The assistant's core safety mechanism (ADR 0007).
 *
 * Every number, amount, date and identifier a tool returns is registered here as a fact and
 * handed to the model as {"fact": "f2", "value": "NPR 400.00"}. The model may mention a fact
 * only as the placeholder {{f2}}; the server checks the answer and substitutes the stored
 * value. So any number the user sees was read from the database during this request.
 */

export interface Fact {
  id: string;
  label: string;
  value: string;
}

/** What a tool result contains in place of a raw value. */
export interface FactRef {
  fact: string;
  value: string;
}

export type FactCheck = { ok: true } | { ok: false; problems: string[] };

const PLACEHOLDER = /\{\{(f\d+)\}\}/g;
/** A decimal digit in any script: 0-9, Devanagari ०-९, Arabic-Indic ٠-٩, full-width ０-９... */
const ANY_DIGIT = /\p{Nd}/u;

export class FactSheet {
  private readonly facts = new Map<string, Fact>();

  add(label: string, value: string): FactRef {
    const id = `f${this.facts.size + 1}`;
    this.facts.set(id, { id, label, value });
    return { fact: id, value };
  }

  /** Accepts only answers whose digits all arrive through placeholders for real facts. */
  check(answer: string): FactCheck {
    const problems: string[] = [];
    if (answer.trim() === '') problems.push('the answer is empty');
    const unknown = [...answer.matchAll(PLACEHOLDER)]
      .map((m) => m[1]!)
      .filter((id) => !this.facts.has(id));
    if (unknown.length > 0) {
      problems.push(`these placeholders match no tool result: ${[...new Set(unknown)].join(', ')}`);
    }
    if (ANY_DIGIT.test(answer.replace(PLACEHOLDER, ''))) {
      problems.push('the answer contains digits outside {{fN}} placeholders');
    }
    return problems.length === 0 ? { ok: true } : { ok: false, problems };
  }

  /** Replaces each placeholder with its stored value. Call only after check() passed. */
  render(answer: string): string {
    return answer.replace(PLACEHOLDER, (_, id: string) => this.facts.get(id)!.value);
  }

  /** The facts an answer actually cites, in order of first mention: its sources. */
  cited(answer: string): Fact[] {
    const ids = [...new Set([...answer.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
    return ids.map((id) => this.facts.get(id)!).filter(Boolean);
  }
}
