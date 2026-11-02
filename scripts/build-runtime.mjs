import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const sourcePaths = [
  'src/recognition/classify.ts',
  'src/interaction/outcome.ts',
  'src/interaction/retry.ts',
  'src/interaction/draft.ts',
  'src/recognition/guard.ts',
];
const outputPath = new URL('dist/recognition/runtime.js', root);

// 허용된 순수 로컬 모듈만 참조하는지 검사
function validateDependencies(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const allowed =
    path === sourcePaths[4]
      ? ['./classify.ts', '../interaction/outcome.ts', '../interaction/draft.ts']
      : path === sourcePaths[3]
        ? ['./retry.ts']
        : [];
  const allowedTypes = path === sourcePaths[3] ? ['../recognition/classify.ts'] : [];

  // 허용한 정적 모듈 경로 검사
  function validateReference(node, typeOnly = false) {
    if (
      !node ||
      !ts.isStringLiteral(node) ||
      (!allowed.includes(node.text) && !(typeOnly && allowedTypes.includes(node.text)))
    ) {
      throw new Error(`Unsupported module dependency in ${path}`);
    }
  }

  // 소스의 모듈 참조와 동적 로딩 검사
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
        validateReference(node.moduleSpecifier, typeOnly);
      }
    } else if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)) {
      throw new Error(`Unsupported module dependency in ${path}`);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error(`Dynamic module loading is not supported in ${path}`);
    } else if (ts.isIdentifier(node) && node.text === 'require') {
      const call = node.parent;
      if (!ts.isCallExpression(call) || call.expression !== node || call.arguments.length !== 1) {
        throw new Error(`Unsupported module dependency in ${path}`);
      }
      validateReference(call.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
}

// 원본 모듈을 독립 실행 가능한 CommonJS로 변환
function transpile(source, path) {
  validateDependencies(source, path);
  const result = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
    },
  });
  const errors = result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length > 0) {
    throw new Error(`TypeScript conversion failed for ${path}: ${errors.map(item => item.code).join(', ')}`);
  }
  validateDependencies(result.outputText, path);
  return result.outputText.trimEnd();
}

// 원본 바이트에서 재현 가능한 REPL 부트스트랩 생성
async function createRuntime() {
  const hash = createHash('sha256');
  const modules = [];
  for (const path of sourcePaths) {
    const bytes = await readFile(new URL(path, root));
    hash.update(Buffer.from(`${path}\0${bytes.length}\0`));
    hash.update(bytes);
    modules.push(transpile(bytes.toString('utf8'), path));
  }
  const sourceHash = hash.digest('hex');
  return `// 대상 재확인 도우미 구성\nvar ccuh = (() => {\n  const classifyExports = {};\n  ((exports) => {\n${modules[0]}\n  })(classifyExports);\n  const outcomeExports = {};\n  ((exports) => {\n${modules[1]}\n  })(outcomeExports);\n  const retryExports = {};\n  ((exports) => {\n${modules[2]}\n  })(retryExports);\n  const draftExports = {};\n  // 초안 처리의 순수 재시도 모듈 제공\n  function requireDraftModule(name) {\n    if (name !== './retry.ts') throw new Error('Unsupported CCUH runtime module');\n    return retryExports;\n  }\n  ((exports, require) => {\n${modules[3]}\n  })(draftExports, requireDraftModule);\n  const localModules = Object.freeze({ './classify.ts': classifyExports, '../interaction/outcome.ts': outcomeExports, '../interaction/draft.ts': draftExports });\n  const guardExports = {};\n  // 허용된 순수 로컬 모듈 제공\n  function requireLocalModule(name) {\n    if (!Object.hasOwn(localModules, name)) throw new Error('Unsupported CCUH runtime module');\n    return localModules[name];\n  }\n  ((exports, require) => {\n${modules[4]}\n  })(guardExports, requireLocalModule);\n  return Object.freeze({ ...guardExports, sourceHash: '${sourceHash}' });\n})();\n`;
}

// 생성물을 갱신하거나 현재 소스와 일치하는지 확인
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node scripts/build-runtime.mjs [--check]');
  }
  const expected = await createRuntime();
  if (args[0] === '--check') {
    const actual = await readFile(outputPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (actual !== expected) throw new Error('CCUH runtime is stale. Run node scripts/build-runtime.mjs');
    console.log('CCUH runtime is current');
    return;
  }
  await mkdir(new URL('./', outputPath), { recursive: true });
  await writeFile(outputPath, expected);
  console.log(`CCUH runtime written: ${fileURLToPath(outputPath)}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
