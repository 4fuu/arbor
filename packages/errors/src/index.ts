/**
 * The core error shape.
 *
 * Every refusal an implementation returns uses this shape, so the model always
 * reads the same kind of refusal: what rule refused the call and what to do
 * instead. An implementation never throws a raw upstream error on its own; it
 * wraps one and adds the rule and the next action.
 *
 * `code` is the stable machine-readable part, `rule` is the rule that refused
 * the call, `message` is the one line the model reads and `nextAction` names
 * what reaches the goal with what the model has now.
 */

/** Machine-readable codes. Implementations may add their own. */
export type ArborErrorCode =
  | "refused"
  | "not_found"
  | "conflict"
  | "invalid_input"
  | "unavailable"
  | "limit_reached"
  | "internal";

export interface ArborErrorInfo {
  code: ArborErrorCode | (string & {});
  /** The rule that refused the call, in one phrase: `note.write.stale_revision`. */
  rule: string;
  /** One line for the model: the rule and the next action. */
  message: string;
  /** What to do instead. Omitted only when the message already says it. */
  nextAction?: string;
  /** Refs that carry the evidence behind the refusal. */
  refs?: readonly string[];
  /** Structured facts a caller or an operator may need. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class ArborError extends Error {
  readonly code: ArborErrorInfo["code"];
  readonly rule: string;
  readonly nextAction?: string;
  readonly refs: readonly string[];
  readonly details: Record<string, unknown>;

  constructor(info: ArborErrorInfo) {
    super(info.message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = "ArborError";
    this.code = info.code;
    this.rule = info.rule;
    this.nextAction = info.nextAction;
    this.refs = info.refs ?? [];
    this.details = info.details ?? {};
  }

  /** The plain shape, for transport across a process or an HTTP boundary. */
  toInfo(): ArborErrorInfo {
    return {
      code: this.code,
      rule: this.rule,
      message: this.message,
      ...(this.nextAction === undefined ? {} : { nextAction: this.nextAction }),
      ...(this.refs.length === 0 ? {} : { refs: this.refs }),
      ...(Object.keys(this.details).length === 0 ? {} : { details: this.details }),
    };
  }
}

/** Build one refusal. */
export function arborError(info: ArborErrorInfo): ArborError {
  return new ArborError(info);
}

export function isArborError(value: unknown): value is ArborError {
  return value instanceof ArborError;
}

/**
 * Wrap anything an implementation caught into the core shape. A value that is
 * already an `ArborError` is returned unchanged.
 */
export function wrapError(
  error: unknown,
  fallback: { rule: string; message: string; nextAction?: string; code?: ArborErrorInfo["code"] },
): ArborError {
  if (isArborError(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ArborError({
    code: fallback.code ?? "internal",
    rule: fallback.rule,
    message: fallback.message,
    ...(fallback.nextAction === undefined ? {} : { nextAction: fallback.nextAction }),
    details: { upstream: detail },
    cause: error,
  });
}
