#!/usr/bin/env bun

import { runScrape } from "./commands/scrape";
import { runExtract } from "./commands/extract";
import { runEmbed } from "./commands/embed";
import { runClassify } from "./commands/classify";
import { runCrawls } from "./commands/crawls";
import { runCdxFilter } from "./commands/cdx-filter";
import { runExport } from "./commands/export";
import { runStatus } from "./commands/status";

const VERSION = "0.1.0";

const HELP = `
corpus v${VERSION}

Usage
  corpus <command> [options]

Commands
  cdx-filter  Filter Common Crawl indexes for .docx URLs (Lambda)
  scrape      Download .docx files from Common Crawl
  extract     Extract text from DOCX files using Docling
  embed       Generate embeddings for extracted documents
  classify    Classify documents by type and topic (ML)
  crawls      List available CDX-filtered crawls from R2
  export      Export corpus metadata to HuggingFace
  status      Show corpus statistics

Options
  --help, -h       Show help for a command
  --version, -v    Show version

Examples
  corpus crawls                        # List available crawls
  corpus scrape --crawl 3 --batch 100  # Scrape latest 3 crawls
  corpus extract -b 100                # Extract text
  corpus classify                      # Classify all pending
  corpus export --push                 # Push to HuggingFace
  corpus status                        # Show pipeline stats
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    process.exit(0);
  }

  const commandArgs = args.slice(1);

  switch (command) {
    case "cdx-filter":
      await runCdxFilter(commandArgs);
      break;
    case "scrape":
      await runScrape(commandArgs);
      break;
    case "extract":
      await runExtract(commandArgs);
      break;
    case "embed":
      await runEmbed(commandArgs);
      break;
    case "classify":
      await runClassify(commandArgs);
      break;
    case "crawls":
      await runCrawls(commandArgs);
      break;
    case "export":
      await runExport(commandArgs);
      break;
    case "status":
      await runStatus(commandArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
