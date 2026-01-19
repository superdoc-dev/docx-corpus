import { describe, expect, test } from "bun:test";

interface ParsedFlags {
  batchSize?: number;
  crawlIds?: string[];
  crawlCount?: number;
  verbose?: boolean;
  force?: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--batch" && args[i + 1]) {
      flags.batchSize = parseInt(args[++i], 10);
    } else if (arg === "--crawl" && args[i + 1]) {
      const value = args[++i];
      // Bare number = count of latest crawls
      if (/^\d+$/.test(value)) {
        flags.crawlCount = parseInt(value, 10);
        flags.crawlIds = undefined;
      } else if (value.includes(",")) {
        // Comma-separated list - filter empty segments
        flags.crawlIds = value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        flags.crawlCount = undefined;
      } else {
        // Single crawl ID
        flags.crawlIds = [value];
        flags.crawlCount = undefined;
      }
    } else if (arg === "--verbose" || arg === "-v") {
      flags.verbose = true;
    } else if (arg === "--force" || arg === "-f") {
      flags.force = true;
    }
  }

  return flags;
}

describe("parseFlags", () => {
  describe("--crawl with number (latest N crawls)", () => {
    test("parses bare number as crawlCount", () => {
      const flags = parseFlags(["--crawl", "3"]);
      expect(flags.crawlCount).toBe(3);
      expect(flags.crawlIds).toBeUndefined();
    });

    test("parses zero as crawlCount", () => {
      const flags = parseFlags(["--crawl", "0"]);
      expect(flags.crawlCount).toBe(0);
    });

    test("parses large number", () => {
      const flags = parseFlags(["--crawl", "100"]);
      expect(flags.crawlCount).toBe(100);
    });
  });

  describe("--crawl with single ID", () => {
    test("parses single crawl ID", () => {
      const flags = parseFlags(["--crawl", "CC-MAIN-2025-51"]);
      expect(flags.crawlIds).toEqual(["CC-MAIN-2025-51"]);
      expect(flags.crawlCount).toBeUndefined();
    });
  });

  describe("--crawl with comma-separated list", () => {
    test("parses comma-separated list", () => {
      const flags = parseFlags(["--crawl", "CC-MAIN-2025-51,CC-MAIN-2025-48"]);
      expect(flags.crawlIds).toEqual(["CC-MAIN-2025-51", "CC-MAIN-2025-48"]);
    });

    test("trims whitespace around IDs", () => {
      const flags = parseFlags(["--crawl", "CC-MAIN-2025-51 , CC-MAIN-2025-48"]);
      expect(flags.crawlIds).toEqual(["CC-MAIN-2025-51", "CC-MAIN-2025-48"]);
    });

    test("filters empty segments from trailing comma", () => {
      const flags = parseFlags(["--crawl", "CC-MAIN-2025-51,"]);
      expect(flags.crawlIds).toEqual(["CC-MAIN-2025-51"]);
    });

    test("filters empty segments from leading comma", () => {
      const flags = parseFlags(["--crawl", ",CC-MAIN-2025-51"]);
      expect(flags.crawlIds).toEqual(["CC-MAIN-2025-51"]);
    });

    test("returns empty array for only commas", () => {
      const flags = parseFlags(["--crawl", ",,,"]);
      expect(flags.crawlIds).toEqual([]);
    });
  });

  describe("--batch", () => {
    test("parses batch size", () => {
      const flags = parseFlags(["--batch", "500"]);
      expect(flags.batchSize).toBe(500);
    });
  });

  describe("--force", () => {
    test("parses --force flag", () => {
      const flags = parseFlags(["--force"]);
      expect(flags.force).toBe(true);
    });

    test("parses -f shorthand", () => {
      const flags = parseFlags(["-f"]);
      expect(flags.force).toBe(true);
    });
  });

  describe("--verbose", () => {
    test("parses --verbose flag", () => {
      const flags = parseFlags(["--verbose"]);
      expect(flags.verbose).toBe(true);
    });

    test("parses -v shorthand", () => {
      const flags = parseFlags(["-v"]);
      expect(flags.verbose).toBe(true);
    });
  });

  describe("combined flags", () => {
    test("parses all flags together", () => {
      const flags = parseFlags([
        "--crawl", "3",
        "--batch", "100",
        "--force",
        "--verbose",
      ]);
      expect(flags.crawlCount).toBe(3);
      expect(flags.batchSize).toBe(100);
      expect(flags.force).toBe(true);
      expect(flags.verbose).toBe(true);
    });

    test("parses crawl ID with other flags", () => {
      const flags = parseFlags([
        "--batch", "50",
        "--crawl", "CC-MAIN-2025-51,CC-MAIN-2025-48",
        "-f",
      ]);
      expect(flags.crawlIds).toEqual(["CC-MAIN-2025-51", "CC-MAIN-2025-48"]);
      expect(flags.batchSize).toBe(50);
      expect(flags.force).toBe(true);
    });
  });

  describe("repeated --crawl flags (last wins)", () => {
    test("ID after count uses ID", () => {
      const flags = parseFlags(["--crawl", "3", "--crawl", "CC-MAIN-2025-51"]);
      expect(flags.crawlIds).toEqual(["CC-MAIN-2025-51"]);
      expect(flags.crawlCount).toBeUndefined();
    });

    test("count after ID uses count", () => {
      const flags = parseFlags(["--crawl", "CC-MAIN-2025-51", "--crawl", "5"]);
      expect(flags.crawlCount).toBe(5);
      expect(flags.crawlIds).toBeUndefined();
    });

    test("list after count uses list", () => {
      const flags = parseFlags(["--crawl", "3", "--crawl", "X,Y"]);
      expect(flags.crawlIds).toEqual(["X", "Y"]);
      expect(flags.crawlCount).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    test("returns empty object for no args", () => {
      const flags = parseFlags([]);
      expect(flags).toEqual({});
    });

    test("ignores unknown flags", () => {
      const flags = parseFlags(["--unknown", "value"]);
      expect(flags).toEqual({});
    });

    test("ignores --crawl without value", () => {
      const flags = parseFlags(["--crawl"]);
      expect(flags.crawlIds).toBeUndefined();
      expect(flags.crawlCount).toBeUndefined();
    });

    test("ignores --batch without value", () => {
      const flags = parseFlags(["--batch"]);
      expect(flags.batchSize).toBeUndefined();
    });
  });
});
