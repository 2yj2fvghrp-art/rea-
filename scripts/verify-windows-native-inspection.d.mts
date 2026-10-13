export const inspectionProbeSource: (loader: string) => string;
export const assertInspectionCleanup: (
  temp: string,
  observed: {
    firstFailed: boolean;
    retainedOwner: boolean;
    probeName: string;
    foreignInode: string;
  },
) => Promise<void>;
