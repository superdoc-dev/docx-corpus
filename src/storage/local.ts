import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface LocalStorage {
  save(hash: string, content: Uint8Array): Promise<boolean>;
  exists(hash: string): Promise<boolean>;
  get(hash: string): Promise<Uint8Array | null>;
  getPath(): string;
}

export function createLocalStorage(basePath: string): LocalStorage {
  const documentsPath = join(basePath, "documents");

  return {
    async save(hash: string, content: Uint8Array): Promise<boolean> {
      await mkdir(documentsPath, { recursive: true });

      const filePath = join(documentsPath, `${hash}.docx`);

      // Check if already exists
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return false; // Already exists, skip
      }

      await Bun.write(filePath, content);
      return true;
    },

    async exists(hash: string): Promise<boolean> {
      const filePath = join(documentsPath, `${hash}.docx`);
      const file = Bun.file(filePath);
      return file.exists();
    },

    async get(hash: string): Promise<Uint8Array | null> {
      const filePath = join(documentsPath, `${hash}.docx`);
      const file = Bun.file(filePath);

      if (!(await file.exists())) {
        return null;
      }

      const buffer = await file.arrayBuffer();
      return new Uint8Array(buffer);
    },

    getPath(): string {
      return documentsPath;
    },
  };
}
