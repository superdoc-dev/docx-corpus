import { loadConfig } from "@docx-corpus/scraper";
import { createDb, header, section, keyValue, blank } from "@docx-corpus/shared";
import { resolve } from "path";

interface ParsedFlags {
  modelsDir: string;
  batchSize: number;
  languages: string;
  modal: boolean;
  workers: number;
  gpu: string;
  verbose: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    modelsDir: "./models",
    batchSize: 128,
    languages: "",
    modal: false,
    workers: 20,
    gpu: "a10g",
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--models-dir":
      case "-m":
        flags.modelsDir = next || flags.modelsDir;
        i++;
        break;
      case "--batch-size":
      case "-b":
        flags.batchSize = parseInt(next || "", 10) || flags.batchSize;
        i++;
        break;
      case "--languages":
      case "-l":
        flags.languages = next || "";
        i++;
        break;
      case "--modal":
        flags.modal = true;
        break;
      case "--workers":
      case "-w":
        flags.workers = parseInt(next || "", 10) || flags.workers;
        i++;
        break;
      case "--gpu":
        flags.gpu = next || flags.gpu;
        i++;
        break;
      case "--verbose":
      case "-v":
        flags.verbose = true;
        break;
    }
  }

  return flags;
}

const HELP = `
corpus classify - Classify documents by type and topic

Usage
  corpus classify [options]

Runs the trained ModernBERT classifiers on all unclassified documents.
Wraps scripts/classification/classify.py — requires Python 3.11+ with
classification dependencies installed.

Options
  --models-dir, -m <dir>   Path to trained models (default: ./models)
  --batch-size, -b <n>     Inference batch size (default: 128)
  --languages, -l <codes>  Comma-separated language filter (e.g. en,ru)
  --modal                  Run on Modal cloud GPUs
  --workers, -w <n>        Modal parallel workers (default: 20)
  --gpu <type>             Modal GPU type (default: a10g)
  --verbose, -v            Show detailed output
  --help, -h               Show this help

Setup
  cd scripts/classification
  pip install -e .    # or: uv pip install -e .

Examples
  corpus classify                              # Classify all pending
  corpus classify -m ~/data/models -b 256      # Custom models dir + batch
  corpus classify -l en,ru                     # Only English and Russian
  corpus classify --modal --workers 20         # Cloud GPU classification
`;

export async function runClassify(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const flags = parseFlags(args);
  const config = loadConfig();
  const db = await createDb(config.database.url);

  try {
    // Show current classification state
    const stats = await db.getLLMClassificationStats();
    header("docx-corpus", "classify");
    section("Current state");
    keyValue("classified", stats.classified);
    keyValue("pending", stats.pending);
    blank();

    if (stats.pending === 0) {
      console.log("All documents are already classified.");
      return;
    }

    // Build Python command
    const scriptDir = resolve(import.meta.dir, "../../../scripts/classification");
    const scriptPath = resolve(scriptDir, "classify.py");

    const pythonArgs = [
      "python", scriptPath,
      "--models-dir", flags.modelsDir,
      "--batch-size", String(flags.batchSize),
    ];

    if (flags.languages) {
      pythonArgs.push("--languages", flags.languages);
    }

    if (flags.modal) {
      pythonArgs.push("--modal");
      pythonArgs.push("--workers", String(flags.workers));
      pythonArgs.push("--gpu", flags.gpu);
    }

    section("Running classifier");
    console.log(`Script:    ${scriptPath}`);
    console.log(`Models:    ${flags.modelsDir}`);
    console.log(`Batch:     ${flags.batchSize}`);
    console.log(`Modal:     ${flags.modal ? `yes (${flags.workers} workers, ${flags.gpu})` : "no (local)"}`);
    if (flags.languages) console.log(`Languages: ${flags.languages}`);
    blank();

    // Run Python classifier as subprocess
    const proc = Bun.spawn(pythonArgs, {
      cwd: scriptDir,
      stdio: ["inherit", "inherit", "inherit"],
      env: {
        ...process.env,
        DATABASE_URL: config.database.url,
      },
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`\nClassification failed with exit code ${exitCode}`);
      process.exit(1);
    }

    // Show updated stats
    blank();
    const updated = await db.getLLMClassificationStats();
    section("Updated state");
    keyValue("classified", updated.classified);
    keyValue("pending", updated.pending);
  } finally {
    await db.close();
  }
}
