/**
 * Structured errors for the convograph config layer.
 *
 * The intent: when a user's `agent.yaml` is invalid, we want to surface a
 * single clear, locatable error message rather than dumping a Zod stack.
 */

import type { ZodError, ZodIssue } from "zod";

export class ConvographConfigError extends Error {
  /** All issues found, in order of discovery. */
  issues: FormattedIssue[];

  /** Source path of the YAML file, if known. */
  source?: string;

  constructor(message: string, issues: FormattedIssue[], source?: string) {
    super(message);
    this.name = "ConvographConfigError";
    this.issues = issues;
    this.source = source;
  }

  /** Multi-line formatted output suitable for CLI / log display. */
  format(): string {
    const header = this.source
      ? `Invalid agent.yaml (${this.source}):`
      : "Invalid agent.yaml:";

    const body = this.issues
      .map((issue, i) => {
        const path =
          issue.path.length > 0 ? issue.path.join(".") : "<root>";
        return `  ${i + 1}. [${path}] ${issue.message}`;
      })
      .join("\n");

    return `${header}\n${body}`;
  }
}

export interface FormattedIssue {
  /** Field path inside the YAML, e.g. ["topics", 0, "slots", 2, "type"]. */
  path: (string | number)[];
  /** Human-readable explanation of what went wrong. */
  message: string;
  /** Zod's internal code (invalid_type, custom, etc.) — useful for tooling. */
  code?: string;
}

/** Converts a ZodError into convograph's structured error type. */
export function fromZodError(
  err: ZodError,
  source?: string
): ConvographConfigError {
  const issues: FormattedIssue[] = err.issues.map((issue: ZodIssue) => ({
    // Zod's path is PropertyKey[] (incl. symbol). YAML configs only ever
    // use string/number keys, so coerce safely.
    path: issue.path.map((p) =>
      typeof p === "symbol" ? p.toString() : (p as string | number)
    ),
    message: issue.message,
    code: issue.code,
  }));
  const summary = `${issues.length} ${
    issues.length === 1 ? "issue" : "issues"
  } in agent.yaml`;
  return new ConvographConfigError(summary, issues, source);
}

/** A YAML syntax / parsing error (before Zod validation). */
export class ConvographYamlSyntaxError extends Error {
  source?: string;
  cause?: unknown;
  constructor(message: string, source?: string, cause?: unknown) {
    super(message);
    this.name = "ConvographYamlSyntaxError";
    this.source = source;
    this.cause = cause;
  }
}
