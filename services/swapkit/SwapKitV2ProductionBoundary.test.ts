import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("has no production entrypoint path to the v1 SwapKit transport", () => {
  const root = resolve(import.meta.dirname, "../..");
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const appPath = resolve(root, "App.tsx");
  const program = ts.createProgram([appPath], parsed.options);
  const checker = program.getTypeChecker();
  const seen = new Set<ts.Node>();
  const violations: string[] = [];
  const walk = (node: ts.Node, trail: string[]) => {
    if (seen.has(node) || ts.isTypeNode(node) || ts.isExportDeclaration(node)) return;
    seen.add(node);
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly) return;
      const symbol = checker.getSymbolAtLocation(node.moduleSpecifier);
      for (const declaration of symbol?.declarations ?? []) {
        if (
          !ts.isSourceFile(declaration) ||
          !declaration.fileName.startsWith(root) ||
          declaration.fileName.includes("node_modules") ||
          declaration.fileName.endsWith("/lib/debug/debugComponents.ts")
        )
          continue;
        for (const statement of declaration.statements) {
          if (
            ts.isImportDeclaration(statement) ||
            ts.isExpressionStatement(statement) ||
            ts.isVariableStatement(statement)
          )
            walk(statement, [...trail, declaration.fileName.slice(root.length + 1)]);
        }
      }
      return;
    }

    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const declaration of symbol?.declarations ?? []) {
        const file = declaration.getSourceFile();
        if (
          !file.fileName.startsWith(root) ||
          file.fileName.includes("node_modules") ||
          file.isDeclarationFile
        )
          continue;
        // Debug loaders are guarded by __DEV__ and cannot run in production.
        if (file.fileName.endsWith("/lib/debug/debugComponents.ts")) continue;
        if (file.fileName.endsWith("/SwapKitService.ts") && node.text === "callSwapKitTool") {
          violations.push([...trail, "SwapKitService.callSwapKitTool"].join(" → "));
          continue;
        }
        let statement: ts.Node = declaration;
        while (statement.parent && !ts.isSourceFile(statement.parent)) statement = statement.parent;
        const label = `${file.fileName.slice(root.length + 1)}:${file.getLineAndCharacterOfPosition(statement.getStart()).line + 1}`;
        walk(statement, [...trail, label]);
      }
    }
    ts.forEachChild(node, (child) => walk(child, trail));
  };
  const app = program.getSourceFile(appPath);
  if (!app) throw new Error("Missing production entrypoint");
  walk(app, ["App.tsx"]);
  expect(violations).toEqual([]);
  // Positive control: the same traversal MUST detect a legacy network entry.
  const legacy = program.getSourceFile(resolve(root, "services/swapkit/SwapKitService.ts"));
  const oldExecute = legacy?.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "executeSwapKitSwap",
  );
  if (!oldExecute) throw new Error("Missing positive control");
  walk(oldExecute, ["legacy positive control"]);
  expect(violations.length).toBeGreaterThan(0);
}, 30_000);
