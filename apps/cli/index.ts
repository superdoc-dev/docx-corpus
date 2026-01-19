#!/usr/bin/env bun

import { runScrape } from "./commands/scrape";
import { runExtract } from "./commands/extract";
import { runStatus } from "./commands/status";

const VERSION = "0.1.0";

const HELP = `
corpus v${VERSION}

Usage
  corpus <command> [options]

Commands
  scrape    Download .docx files from Common Crawl
  extract   Extract text from DOCX files using Docling
  status    Show corpus statistics

Options
  --help    Show help for a command

Examples
  corpus scrape --crawl 3 --batch 100
  corpus extract -i ./docs -o ./output
  corpus status
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const commandArgs = args.slice(1);

  switch (command) {
    case "scrape":
      await runScrape(commandArgs);
      break;
    case "extract":
      await runExtract(commandArgs);
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
