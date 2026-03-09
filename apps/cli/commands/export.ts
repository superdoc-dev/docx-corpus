import { resolve } from "path";

interface ParsedFlags {
  push: boolean;
  private: boolean;
  output: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    push: false,
    private: false,
    output: "docx-corpus.parquet",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--push":
        flags.push = true;
        break;
      case "--private":
        flags.private = true;
        break;
      case "--output":
      case "-o":
        flags.output = next || flags.output;
        i++;
        break;
    }
  }

  return flags;
}

const HELP = `
corpus export - Export corpus metadata to HuggingFace

Usage
  corpus export [options]

Exports classified document metadata to a Parquet file and optionally
pushes to HuggingFace. Wraps scripts/export-hf.py — requires Python 3.11+
with uv (dependencies are inline in the script).

Options
  --push                Push to HuggingFace (default: local export only)
  --private             Create as private dataset
  --output, -o <path>   Local parquet output path (default: docx-corpus.parquet)
  --help, -h            Show this help

Setup
  uv is recommended (dependencies are declared inline in the script).
  huggingface-cli login   # Required for --push

Examples
  corpus export                    # Dry run: export parquet locally
  corpus export --push             # Export and push to HuggingFace
  corpus export --push --private   # Push as private dataset
`;

export async function runExport(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const flags = parseFlags(args);
  const scriptPath = resolve(import.meta.dir, "../../../scripts/export-hf.py");

  const uvArgs = ["uv", "run", scriptPath];

  if (flags.push) uvArgs.push("--push");
  if (flags.private) uvArgs.push("--private");
  uvArgs.push("--output", flags.output);

  console.log("HuggingFace Export");
  console.log("==================");
  console.log(`Script: ${scriptPath}`);
  console.log(`Output: ${flags.output}`);
  console.log(`Push:   ${flags.push ? "yes" : "no (dry run)"}`);
  console.log("");

  const proc = Bun.spawn(uvArgs, {
    cwd: resolve(import.meta.dir, "../../.."),
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`\nExport failed with exit code ${exitCode}`);
    process.exit(1);
  }
}
