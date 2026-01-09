/**
 * Validate that a file is a valid .docx document
 *
 * .docx files are ZIP archives containing:
 * - [Content_Types].xml (required)
 * - word/document.xml (required for document content)
 * - _rels/.rels (required)
 */

// ZIP file magic bytes: PK\x03\x04
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

/**
 * Check if data is a valid .docx file
 */
export function validateDocx(data: Uint8Array): ValidationResult {
  // Check minimum size
  if (data.length < 100) {
    return { isValid: false, error: "File too small to be valid docx" };
  }

  // Check ZIP magic bytes
  if (!hasZipMagic(data)) {
    return {
      isValid: false,
      error: "Not a valid ZIP file (wrong magic bytes)",
    };
  }

  // Try to find required files in the ZIP
  // We do a simple check for the presence of "[Content_Types].xml" string
  // without fully parsing the ZIP (for performance)
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);

  if (!text.includes("[Content_Types].xml")) {
    return {
      isValid: false,
      error: "Missing [Content_Types].xml - not a valid Office document",
    };
  }

  if (!text.includes("word/document.xml") && !text.includes("word/document")) {
    return {
      isValid: false,
      error: "Missing word/document.xml - not a valid Word document",
    };
  }

  return { isValid: true };
}

/**
 * Check if data starts with ZIP magic bytes
 */
function hasZipMagic(data: Uint8Array): boolean {
  if (data.length < ZIP_MAGIC.length) return false;

  for (let i = 0; i < ZIP_MAGIC.length; i++) {
    if (data[i] !== ZIP_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Compute SHA-256 hash of data
 */
export async function computeHash(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    data as unknown as BufferSource,
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Extract original filename from URL
 */
export function extractFilename(url: string): string {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const filename = path.split("/").pop() || "unknown.docx";
    // Decode URL encoding
    return decodeURIComponent(filename);
  } catch {
    return "unknown.docx";
  }
}
