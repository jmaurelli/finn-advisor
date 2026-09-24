import { z } from "zod";
import {
  ApplyBudgetChangeBody as GeneratedApplyBody, ApplyBudgetChangeResponse, GetBudgetPlanResponse,
  ListBudgetsResponse, PreviewBudgetChangeBody as GeneratedChangeBody, PreviewBudgetChangeResponse,
} from "@workspace/api-zod";

/** The contract's own names for the four budget operations' payloads. */
export const BudgetMonth = ListBudgetsResponse;
export const BudgetPlan = GetBudgetPlanResponse;
export const BudgetChangeBody = GeneratedChangeBody;
export const BudgetChangePreview = PreviewBudgetChangeResponse;
export const ApplyBudgetChangeBody = GeneratedApplyBody;
export const BudgetChangeApplyResult = ApplyBudgetChangeResponse;

export type BudgetChangeBody = z.infer<typeof GeneratedChangeBody>;
export type BudgetChangePreview = z.infer<typeof PreviewBudgetChangeResponse>;
export type BudgetPlan = z.infer<typeof GetBudgetPlanResponse>;
