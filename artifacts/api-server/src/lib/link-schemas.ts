import { z } from "zod";
import {
  ClassifyTransactionBody as GeneratedClassifyBody,
  ClassifyTransactionResponse as GeneratedClassifyResult,
  CreateRefundLinkBody as GeneratedRefundLinkBody,
  CreateRefundLinkResponse as GeneratedRefundLinkResult,
  CreateTransferPairBody as GeneratedTransferPairBody,
  CreateTransferPairResponse as GeneratedTransferPairResult,
  DeleteTransferPairResponse as GeneratedUnlinkResult,
  GetRefundLinkResponse as GeneratedRefundLink,
  GetTransferPairResponse as GeneratedTransferPair,
  ListRefundCandidatesResponse as GeneratedRefundCandidatePage,
  ListTransferCandidatesResponse as GeneratedTransferCandidateList,
} from "@workspace/api-zod";
import { Transaction } from "./transaction-schemas.js";

const lower = z.string().uuid().transform(value => value.toLowerCase());

// The contract's uniqueItems cannot see that an upper-case and a lower-case ID
// are the same record, so uniqueness is checked after canonicalizing.
const uniqueIds = (max: number) => z.array(lower).max(max).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "List each link once." });
});

export const UnlinkSet = z.object({ transferPairIds: uniqueIds(1), refundLinkIds: uniqueIds(500) }).strict();
export type UnlinkSet = z.output<typeof UnlinkSet>;

export const ClassifyBody = z.object({
  kind: GeneratedClassifyBody.shape.kind,
  category: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("category"), categoryId: lower }).strict(),
    z.object({ mode: z.literal("rules") }).strict(),
  ]).optional(),
  confirmUnlink: UnlinkSet.optional(),
}).strict();
export type ClassifyInput = z.output<typeof ClassifyBody>;
export const ClassifyResult = GeneratedClassifyResult.extend({ transaction: Transaction });

export const TransferPairBody = GeneratedTransferPairBody.extend({
  id: lower,
  legs: z.array(z.object({ transactionId: lower,
    version: GeneratedTransferPairBody.shape.legs.element.shape.version }).strict()).min(2).max(2),
});
export type TransferPairInput = z.output<typeof TransferPairBody>;
export const TransferPair = GeneratedTransferPair;
export const TransferPairResult = GeneratedTransferPairResult.extend({ transactions: z.array(Transaction).min(2).max(2) });

export const RefundLinkBody = GeneratedRefundLinkBody.extend({ id: lower, refundId: lower, purchaseId: lower });
export type RefundLinkInput = z.output<typeof RefundLinkBody>;
export const RefundLink = GeneratedRefundLink;
export const RefundLinkResult = GeneratedRefundLinkResult;
export const UnlinkResult = GeneratedUnlinkResult;

const transferCandidate = GeneratedTransferCandidateList.shape.items.element;
export const TransferCandidateList = GeneratedTransferCandidateList.extend({
  items: z.array(transferCandidate.extend({ transaction: Transaction })).max(50),
});
const refundCandidate = GeneratedRefundCandidatePage.shape.items.element;
export const RefundCandidatePage = GeneratedRefundCandidatePage.extend({
  items: z.array(refundCandidate.extend({ transaction: Transaction })).max(200),
});
