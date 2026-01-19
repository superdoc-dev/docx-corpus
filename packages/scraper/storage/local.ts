import { join } from "node:path";

export interface LocalStorage {
  save(hash: string, content: Uint8Array): Promise<boolean>;
}

export function createLocalStorage(basePath: string): LocalStorage {
  const documentsPath = join(basePath, "documents");

  return {
    async save(hash: string, content: Uint8Array): Promise<boolean> {
      const filePath = join(documentsPath, `${hash}.docx`);

      // Check if already exists
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return false; // Already exists, skip
      }

      // Bun.write auto-creates parent directories
      await Bun.write(filePath, content);
      return true;
    },
  };
}
