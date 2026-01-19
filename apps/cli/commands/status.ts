import { loadConfig, createDb, VERSION } from "@docx-corpus/scraper";
import { header, section, keyValue, blank } from "@docx-corpus/shared";

export async function runStatus(_args: string[]) {
  header("docx-corpus", VERSION);

  const config = loadConfig();
  const db = await createDb(config.database.url);

  const stats = await db.getStats();

  section("Corpus Status");
  blank();

  let total = 0;
  for (const { status, count } of stats) {
    keyValue(status, count);
    total += count;
  }

  blank();
  keyValue("Total", total);
}
