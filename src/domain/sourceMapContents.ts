/** Validate optional content entries; ECMA-426 permits any array length. */
export const hasValidSourceMapContents = (contents: unknown): boolean =>
  contents === undefined ||
  contents === null ||
  (Array.isArray(contents) &&
    contents.every(
      (content: unknown) => content === null || typeof content === "string",
    ));
