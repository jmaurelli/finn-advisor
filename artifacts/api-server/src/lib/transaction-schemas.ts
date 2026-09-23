import { z } from "zod";
import {
  CategorizeTransactionBody as GeneratedCategorizeBody,
  CategorizeTransactionResponse as GeneratedCategorizeResult,
  GetTransactionResponse as GeneratedTransaction,
  GetTransactionHistoryResponse as GeneratedHistory,
  ListTransactionsResponse as GeneratedPage,
  UpdateTransactionNoteBody as GeneratedNoteBody,
  UpdateTransactionNoteResponse as GeneratedTransactionResult,
} from "@workspace/api-zod";
import { wellFormed } from "./category-schemas.js";
import { Rule, rulePattern } from "./rule-schemas.js";

export function codepointText(maximum: number) {
  return z.string().refine(value => [...value].length <= maximum,
    `Use at most ${maximum} characters.`).refine(wellFormed, "Use valid Unicode text.");
}

export const merchantText = codepointText(2000).refine(value => /\S/u.test(value),
  "Enter a merchant description, not only spaces.");
export const noteText = codepointText(1000).refine(value => /\S/u.test(value),
  "Enter a note, or use null to clear it.");

export const Transaction = GeneratedTransaction.extend({
  merchant: codepointText(2000).refine(value => value.length > 0, "A merchant description is required."),
  // Legacy records can contain an empty note; new notes must be nonblank.
  note: codepointText(1000).nullable(),
});

export const PostingInput = z.object({
  accountId: z.string().uuid().transform(value => value.toLowerCase()),
  postedDate: z.string(),
  merchant: merchantText,
  money: z.object({ amountMinor: z.string(), currency: z.literal("USD") }).strict(),
  kind: z.enum(["purchase", "refund", "income", "transfer"]),
  category: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("rules") }).strict(),
    z.object({ mode: z.literal("category"), categoryId: z.string().uuid().transform(value => value.toLowerCase()) }).strict(),
  ]).optional(),
  note: noteText.nullish(),
}).strict();

export type PostingInput = z.input<typeof PostingInput>;

const event = GeneratedHistory.shape.items.element;
export const HistorySnapshot = event.shape.after.options[0].extend({
  categoryName: codepointText(60).nullish(), note: codepointText(1000).nullish(),
});
export const HistoryEvent = event.extend({
  reason: codepointText(500).nullable(),
  before: HistorySnapshot.nullable(), after: HistorySnapshot.nullable(),
});
export const HistoryPage = GeneratedHistory.extend({ items: z.array(HistoryEvent).max(100) });

// Transaction lists and correction commands reuse the corrected Transaction.
export const TransactionPage = GeneratedPage.extend({ items: z.array(Transaction).max(200) });
export const TransactionResult = GeneratedTransactionResult.extend({ transaction: Transaction });
export const CategorizeBody = GeneratedCategorizeBody.extend({
  newRule: GeneratedCategorizeBody.shape.newRule.unwrap().extend({ pattern: rulePattern }).optional(),
});
export const CategorizeResult = GeneratedCategorizeResult.extend({ transaction: Transaction, rule: Rule.nullable() });
export const UpdateNoteBody = GeneratedNoteBody.extend({ note: noteText.nullable() });
