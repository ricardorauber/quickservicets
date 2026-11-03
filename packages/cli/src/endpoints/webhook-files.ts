import ts from "typescript";

/** The `defineWebhook(...)` call a `webhook.ts` file default-exports, if any. */
export function webhookCallOf(source: string, file: string): ts.CallExpression | undefined {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    let expression = statement.expression;
    while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isCallExpression(expression)) {
      const callee = ts.isIdentifier(expression.expression) ? expression.expression.text : ts.isPropertyAccessExpression(expression.expression) ? expression.expression.name.text : undefined;
      if (callee === "defineWebhook") return expression;
    }
  }
  return undefined;
}

/** The verifier names the built-in verifier functions document as. */
const VERIFIER_NAMES: Readonly<Record<string, string>> = { stripeSignature: "stripe", githubSignature: "github", standardWebhookSignature: "standard-webhooks", hmacSignature: "hmac" };

/** The verifier a `webhook.ts` file uses, for the API docs: a built-in's name, a registered name, or `custom`. */
export function webhookVerifierName(source: string, file: string): string {
  const call = webhookCallOf(source, file);
  const options = call?.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return "custom";
  const verify = options.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "verify");
  if (!verify) return "custom";
  const value = verify.initializer;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) return VERIFIER_NAMES[value.expression.text] ?? "custom";
  return "custom";
}


/** Whether a `webhook.ts` file's `defineWebhook` options set `async: true`. */
export function isAsyncWebhook(source: string, file: string): boolean {
  const options = webhookCallOf(source, file)?.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "async" && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
}
