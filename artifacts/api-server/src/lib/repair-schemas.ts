import { z } from "zod";
import {
  ApplyRepairBody, ApplyRepairResponse as GeneratedResult,
  GetRepairPreviewResponse as GeneratedPreview,
} from "@workspace/api-zod";
import { codepointText, Transaction } from "./transaction-schemas.js";

const reason = codepointText(500).refine(value => /\S/u.test(value), "Enter a reason, not only spaces.");
export const RepairBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("correct"), reason, postedDate: z.string().optional(),
    money: z.object({ amountMinor: z.string(), currency: z.literal("USD") }).strict().optional() }).strict(),
  z.object({ action: z.literal("void"), reason }).strict(),
  z.object({ action: z.literal("restore"), reason }).strict(),
]);
export type RepairInput = z.output<typeof RepairBody>;
export const RepairPreview = GeneratedPreview.extend({ reason });
export type RepairPreview = z.output<typeof RepairPreview>;
export const RepairResult = GeneratedResult.extend({ repair: RepairPreview, transaction: Transaction });
export const ApplyBody = ApplyRepairBody;
