/**
 * Per-file syntax + type check across every workspace module.
 *
 * Usage:
 *   pnpm run check              (from repo root)
 *   pnpm --filter @workspace/scripts run check
 *   tsx scripts/src/check-all.ts [--module=<path>] [--syntax-only]
 *
 * What it does:
 *  1. Discovers every workspace module that has a tsconfig.json
 *     (artifacts/*, lib/*, lib/integrations/*, scripts).
 *  2. SYNTAX CHECK (always runs, needs no installed dependencies):
 *     parses every .ts/.tsx file with the TypeScript parser and reports
 *     any parse errors, per file.
 *  3. TYPE CHECK (needs node_modules to be installed for real results):
 *     builds a ts.Program per module using that module's tsconfig.json
 *     and reports diagnostics grouped per file.
 *  4. Prints a report with files that have issues listed first as
 *     warnings, followed by a clean summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FileIssue {
  file: string;
  line: number;
  col: number;
  code: number;
  category: "syntax" | "type";
  message: string;
}

interface ModuleResult {
  module: string;
  fileCount: number;
  issuesByFile: Map<string, FileIssue[]>;
  typeCheckSkipped: boolean;
  typeCheckSkipReason?: string;
}

const REPO_ROOT = path.resolve(__dirname, "../../");

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".generated",
  ".next",
  ".expo",
]);

function discoverModules(root: string): string[] {
  const candidates = [
    "artifacts",
    "lib",
    "lib/integrations",
    "scripts",
  ];
  const modules: string[] = [];
  for (const dir of candidates) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (!stat.isDirectory()) continue;
    if (fs.existsSync(path.join(full, "tsconfig.json"))) {
      modules.push(dir);
      continue;
    }
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const modPath = path.join(dir, entry.name);
      if (fs.existsSync(path.join(root, modPath, "tsconfig.json"))) {
        modules.push(modPath);
      }
    }
  }
  return Array.from(new Set(modules)).sort();
}

function walkTsFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
}

function syntaxCheckFile(filePath: string): FileIssue[] {
  const text = fs.readFileSync(filePath, "utf8");
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const diagnostics = (sourceFile as any).parseDiagnostics as ts.Diagnostic[] | undefined;
  if (!diagnostics || diagnostics.length === 0) return [];
  return diagnostics.map((d) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(d.start!);
    return {
      file: filePath,
      line: line + 1,
      col: character + 1,
      code: d.code,
      category: "syntax" as const,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  });
}

function typeCheckModule(moduleDir: string): {
  issuesByFile: Map<string, FileIssue[]>;
  skipped: boolean;
  skipReason?: string;
} {
  const tsconfigPath = path.join(moduleDir, "tsconfig.json");
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    return {
      issuesByFile: new Map(),
      skipped: true,
      skipReason: ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    };
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    moduleDir,
    undefined,
    tsconfigPath
  );
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ];

  const issuesByFile = new Map<string, FileIssue[]>();
  let missingDepCount = 0;

  for (const d of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    // TS2307/TS2688/TS6053 = cannot find module / type defs / referenced tsconfig.
    // These are dependency-resolution noise when node_modules isn't installed,
    // not real bugs in the code — still recorded, but tagged separately.
    if (d.code === 2307 || d.code === 2688 || d.code === 6053) missingDepCount++;

    const file = d.file ? d.file.fileName : `<${moduleDir}/tsconfig.json>`;
    const pos =
      d.file && d.start !== undefined
        ? d.file.getLineAndCharacterOfPosition(d.start)
        : { line: 0, character: 0 };
    const issue: FileIssue = {
      file,
      line: pos.line + 1,
      col: pos.character + 1,
      code: d.code,
      category: "type",
      message,
    };
    const list = issuesByFile.get(file) ?? [];
    list.push(issue);
    issuesByFile.set(file, list);
  }

  return { issuesByFile, skipped: false };
}

function isDependencyNoise(code: number): boolean {
  return code === 2307 || code === 2688 || code === 6053;
}

function main() {
  const args = process.argv.slice(2);
  const syntaxOnly = args.includes("--syntax-only");
  const force = args.includes("--force");
  const moduleArg = args.find((a) => a.startsWith("--module="));
  const onlyModule = moduleArg ? moduleArg.split("=")[1] : undefined;

  const modules = onlyModule ? [onlyModule] : discoverModules(REPO_ROOT);
  const results: ModuleResult[] = [];

  for (const mod of modules) {
    const modDir = path.join(REPO_ROOT, mod);
    const files: string[] = [];
    walkTsFiles(modDir, files);

    const issuesByFile = new Map<string, FileIssue[]>();

    // 1. syntax check, always
    for (const f of files) {
      const issues = syntaxCheckFile(f);
      if (issues.length) issuesByFile.set(f, issues);
    }

    // 2. type check, unless skipped
    let typeCheckSkipped = false;
    let typeCheckSkipReason: string | undefined;
    if (!syntaxOnly) {
      // A real semantic type-check is only meaningful once dependencies are
      // installed (react/@types/node/etc). Without them, TS reports missing
      // globals (console/process), missing modules, missing --jsx, etc. for
      // almost every file — noise that would drown out genuine bugs. So we
      // check for an installed node_modules (root, or hoisted per-module)
      // before running the semantic pass.
      const hasRootModules = fs.existsSync(path.join(REPO_ROOT, "node_modules"));
      const hasModuleModules = fs.existsSync(path.join(modDir, "node_modules"));
      if (!force && !hasRootModules && !hasModuleModules) {
        typeCheckSkipped = true;
        typeCheckSkipReason =
          "node_modules not installed — run `pnpm install` first (needs network access) for a real type check. Skipping to avoid reporting dependency-resolution noise as bugs.";
      } else {
        const { issuesByFile: typeIssues, skipped, skipReason } = typeCheckModule(modDir);
        typeCheckSkipped = skipped;
        typeCheckSkipReason = skipReason;
        for (const [file, issues] of typeIssues) {
          const existing = issuesByFile.get(file) ?? [];
          issuesByFile.set(file, existing.concat(issues));
        }
      }
    }

    results.push({
      module: mod,
      fileCount: files.length,
      issuesByFile,
      typeCheckSkipped,
      typeCheckSkipReason,
    });
  }

  // ---- report ----
  let totalFiles = 0;
  let totalFilesWithIssues = 0;
  let totalRealIssues = 0;
  let totalDepNoise = 0;

  console.log("=".repeat(70));
  console.log("WARNINGS (files with issues) — shown first");
  console.log("=".repeat(70));

  for (const r of results) {
    totalFiles += r.fileCount;
    if (r.issuesByFile.size === 0) continue;

    for (const [file, issues] of r.issuesByFile) {
      totalFilesWithIssues++;
      const rel = path.relative(REPO_ROOT, file);
      console.log(`\n⚠️  ${rel}`);
      for (const issue of issues) {
        const tag = issue.category === "syntax" ? "SYNTAX" : "TYPE";
        const noise = isDependencyNoise(issue.code);
        if (noise) totalDepNoise++;
        else totalRealIssues++;
        const noiseTag = noise ? " [dependency-not-installed]" : "";
        console.log(
          `    [${tag}${noiseTag}] Line ${issue.line}:${issue.col} TS${issue.code} ${issue.message}`
        );
      }
    }
  }

  if (totalFilesWithIssues === 0) {
    console.log("\n(none — every file is clean)");
  }

  const skippedModules = results.filter((r) => r.typeCheckSkipped);
  if (skippedModules.length > 0) {
    console.log("\n" + "=".repeat(70));
    console.log("TYPE CHECK SKIPPED FOR THESE MODULES");
    console.log("=".repeat(70));
    for (const r of skippedModules) {
      console.log(`  ${r.module}: ${r.typeCheckSkipReason}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  console.log(`Modules checked      : ${results.length}`);
  console.log(`Total files scanned  : ${totalFiles}`);
  console.log(`Files with issues    : ${totalFilesWithIssues}`);
  console.log(`Real code issues     : ${totalRealIssues}`);
  console.log(`Dependency-noise refs: ${totalDepNoise}  (Cannot find module/type-defs — install deps to clear)`);
  console.log();
  for (const r of results) {
    const withIssues = Array.from(r.issuesByFile.keys()).length;
    const skipNote = r.typeCheckSkipped ? "  [type-check skipped]" : "";
    console.log(`  ${r.module.padEnd(28)} files=${String(r.fileCount).padEnd(4)} filesWithIssues=${withIssues}${skipNote}`);
  }

  if (totalRealIssues > 0) {
    process.exitCode = 1;
  }
}

main();
