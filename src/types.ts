import z from "zod";

export const PossiblePhases = z.enum([
  "Pending",
  "Running",
  "Succeeded",
  "Failed",
  "Unknown",
]);
