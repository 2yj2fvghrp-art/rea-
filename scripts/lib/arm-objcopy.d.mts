export declare const selectArmObjcopy: (
  candidates: readonly string[],
  execute: (
    command: string,
    args: readonly string[],
    options: { readonly timeout: number },
  ) => Promise<unknown>,
) => Promise<string>;
