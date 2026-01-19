import { processDirectory, type ExtractConfig } from "@docx-corpus/extractor";

interface ParsedFlags {
  inputDir: string;
  outputDir: string;
  batchSize: number;
  workers: number;
  resume: boolean;
  verbose: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    inputDir: "",
    outputDir: "",
    batchSize: 100,
    workers: 4,
    resume: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--input":
      case "-i":
        flags.inputDir = next || "";
        i++;
        break;
      case "--output":
      case "-o":
        flags.outputDir = next || "";
        i++;
        break;
      case "--batch-size":
      case "-b":
        flags.batchSize = parseInt(next || "100", 10);
        i++;
        break;
      case "--workers":
      case "-w":
        flags.workers = parseInt(next || "4", 10);
        i++;
        break;
      case "--resume":
      case "-r":
        flags.resume = true;
        break;
      case "--verbose":
      case "-v":
        flags.verbose = true;
        break;
    }
  }

  return flags;
}

function validateFlags(flags: ParsedFlags): string | null {
  if (!flags.inputDir) return "Error: --input (-i) is required";
  if (!flags.outputDir) return "Error: --output (-o) is required";
  if (flags.batchSize < 1 || flags.batchSize > 10000) {
    return "Error: --batch-size must be between 1 and 10000";
  }
  if (flags.workers < 1 || flags.workers > 32) {
    return "Error: --workers must be between 1 and 32";
  }
  return null;
}

const HELP = `
corpus extract - Extract text from DOCX files using Docling

Usage
  corpus extract [options]

Options
  --input, -i <dir>       Input directory containing DOCX files (required)
  --output, -o <dir>      Output directory for extracted data (required)
  --batch-size, -b <n>    Number of files per batch (default: 100)
  --workers, -w <n>       Number of parallel workers (default: 4)
  --resume, -r            Resume from last checkpoint
  --verbose, -v           Show detailed progress

Examples
  corpus extract -i ./docs -o ./output
  corpus extract -i ./docs -o ./output --resume -v
`;

export async function runExtract(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const flags = parseFlags(args);
  const error = validateFlags(flags);

  if (error) {
    console.error(error);
    console.error("Use 'corpus extract --help' for usage information");
    process.exit(1);
  }

  const config: ExtractConfig = {
    inputDir: flags.inputDir,
    outputDir: flags.outputDir,
    batchSize: flags.batchSize,
    workers: flags.workers,
    resume: flags.resume,
  };

  console.log("Text Extractor");
  console.log("==============");
  console.log(`Input:   ${config.inputDir}`);
  console.log(`Output:  ${config.outputDir}`);
  console.log(`Workers: ${config.workers}`);
  if (config.resume) console.log("Resume:  enabled");
  console.log("");

  try {
    await processDirectory(config, flags.verbose);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}
