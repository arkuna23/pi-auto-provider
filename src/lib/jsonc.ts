import { readFile } from "node:fs/promises";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export class JsoncFileError extends Error {
  constructor(public readonly filePath: string, message: string) {
    super(`${filePath}: ${message}`);
    this.name = "JsoncFileError";
  }
}

export async function readJsonc(path: string): Promise<{ exists: boolean; value?: unknown; error?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { exists: false };
    return { exists: true, error: `${path}: ${errorMessage(error)}` };
  }

  const errors: ParseError[] = [];
  const value = parse(text.replace(/^\uFEFF/, ""), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    return {
      exists: true,
      error: `${path}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    };
  }
  return { exists: true, value };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
