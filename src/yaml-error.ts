import { YAMLError } from "yaml";

/** A YAML syntax refusal message that names the place and the parser's
 * error code only. The parser's own message quotes the offending line,
 * which may hold a key pasted where a variable name belongs. */
export function yamlSyntaxRefusal(origin: string, err: unknown): string {
  if (!(err instanceof YAMLError)) return `${origin} is not valid YAML`;
  const at = err.linePos?.[0];
  const where = at === undefined ? "" : ` at line ${at.line}, column ${at.col}`;
  return `${origin} is not valid YAML${where} (${err.code}); fix the syntax there`;
}
