/** Require a sealed identifier and Apple Developer ID signing team together. */
export const macDeveloperIdRequirement = (
  identifier: string,
  teamIdentifier: string,
): string => {
  if (!/^[\w.-]+$/.test(identifier) || !/^[\w.-]+$/.test(teamIdentifier))
    throw new TypeError(
      "macDeveloperIdRequirement identifiers must contain only alphanumeric characters, dots, and hyphens.",
    );
  return (
    `= identifier "${identifier}" and anchor apple generic` +
    ` and certificate leaf[subject.OU] = "${teamIdentifier}"`
  );
};
