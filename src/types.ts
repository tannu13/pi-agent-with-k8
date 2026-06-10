import z from "zod";

export const PossiblePhases = z.enum([
  "Pending",
  "Running",
  "Succeeded",
  "Failed",
  "Unknown",
]);

export type TPossiblePhases = z.infer<typeof PossiblePhases>;
