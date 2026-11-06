/**
 * The secret scrub: no configured secret value reaches the journal, the model
 * or the judge (docs/architecture.md#data-placement).
 *
 * A configuration names its secrets and never holds their values, so the host
 * resolves each name through `secretOf` - `process.env` by default - and this
 * scrubber holds the values for as long as the host runs. Every form a value
 * can take is replaced: the raw value, its base64 and its URL-encoded form,
 * longest first, so a longer form is never left holding part of a shorter one.
 * A value shorter than four characters is not a secret and is left alone: too
 * short a string would redact ordinary text.
 *
 * The scrubber is refreshable: settings are the model's to change, and a name
 * that appears or disappears there takes effect on the next refresh rather
 * than at construction.
 */

import type { TextTable } from "@4fu/arbor-interfaces";
import { textOf } from "@4fu/arbor-prompt";

/** The shortest value the scrubber replaces. */
export const MIN_SECRET_LENGTH = 4;

/**
 * The shortest value of a host variable that is scrubbed by its name alone. It
 * is longer than a configured secret's minimum because no one chose it: a short
 * value under a matching name is more likely ordinary text than a credential.
 */
const MIN_HOST_CREDENTIAL_LENGTH = 8;

/** The name segments that mark a host variable as a credential. */
const CREDENTIAL_SEGMENTS = new Set([
  "KEY",
  "APIKEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASS",
  "CREDENTIAL",
  "CREDENTIALS",
]);

/**
 * The host variables that look like credentials. A child process inherits the
 * host's whole environment, so a credential the host carries for itself - the
 * model provider's key, a registry token - is one `env` away from the model
 * even when no configuration names it. A name counts when one of its
 * `_`-separated segments is a credential word (`NPM_TOKEN`, `DEEPSEEK_API_KEY`,
 * `AWS_SECRET_ACCESS_KEY`), which leaves `SSH_AUTH_SOCK`, `PWD` and the like
 * alone. A credential under any other name is covered by naming it in
 * `settings.secrets`.
 */
export function hostCredentialNames(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => {
      if (value === undefined || value.length < MIN_HOST_CREDENTIAL_LENGTH) return false;
      return name
        .toUpperCase()
        .split("_")
        .some((segment) => CREDENTIAL_SEGMENTS.has(segment));
    })
    .map(([name]) => name);
}

/** One configured secret, by the name its configuration gave it. */
export interface NamedSecret {
  name: string;
  value: string;
}

/** One string to replace, with the secret it belongs to. */
interface Form {
  name: string;
  value: string;
  form: string;
}

export class SecretScrub {
  private readonly table: TextTable;
  /** Every form to replace, longest first. */
  private forms: readonly Form[] = [];

  constructor(table: TextTable) {
    this.table = table;
  }

  /**
   * Read the named secrets again. A name that resolves to nothing, or to a
   * value too short to be a secret, is dropped.
   */
  refresh(names: readonly string[], secretOf: (name: string) => string | undefined): void {
    const forms: Form[] = [];
    for (const name of names) {
      const value = secretOf(name);
      if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
      forms.push({ name, value, form: value });
      for (const encoded of [base64Of(value), encodeURIComponent(value)]) {
        if (encoded === value) continue;
        forms.push({ name, value, form: encoded });
      }
    }
    // Longest first: a value's base64 form holds the raw value, so replacing
    // the shorter one first would leave the tail of the longer one behind.
    forms.sort((left, right) => right.form.length - left.form.length || (left.form < right.form ? -1 : 1));
    this.forms = forms;
  }

  /** True once at least one secret is being replaced. */
  get active(): boolean {
    return this.forms.length > 0;
  }

  /** The secret a text holds, when it holds one. */
  secretIn(text: string): NamedSecret | undefined {
    for (const one of this.forms) {
      if (text.includes(one.form)) return { name: one.name, value: one.value };
    }
    return undefined;
  }

  /** The text with every secret value replaced by its placeholder. */
  apply(text: string): string {
    let out = text;
    for (const one of this.forms) {
      if (!out.includes(one.form)) continue;
      out = out.split(one.form).join(this.placeholder(one.name));
    }
    return out;
  }

  /** The same scrub over every string inside a structured value. */
  applyJson(value: unknown): unknown {
    if (typeof value === "string") return this.apply(value);
    if (Array.isArray(value)) return value.map((entry) => this.applyJson(entry));
    if (value !== null && typeof value === "object") {
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        next[key] = this.applyJson(entry);
      }
      return next;
    }
    return value;
  }

  private placeholder(name: string): string {
    return textOf(this.table, "secret.hidden", { name });
  }
}

/** A value's base64 form, which is what a base64 tool or log carries. */
function base64Of(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
