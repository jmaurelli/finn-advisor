import { accounts, budgets, categories, importBatches, rules, transactions } from './mock-data';
import type { Account, Budget, Category, CategoryRule, ImportBatch, Transaction } from './finance';

/**
 * Replace this object with an API-backed adapter when the prototype grows.
 * Pages only talk to the local FinanceProvider, which keeps that migration contained.
 */
export const mockFinanceDataAccess = {
  getAccounts: (): Account[] => accounts.map((account) => ({ ...account })),
  getTransactions: (): Transaction[] => transactions.map((transaction) => ({ ...transaction })),
  getBudgets: (): Budget[] => budgets.map((budget) => ({ ...budget })),
  getCategories: (): Category[] => categories.map((category) => ({ ...category })),
  getRules: (): CategoryRule[] => rules.map((rule) => ({ ...rule })),
  getImports: (): ImportBatch[] => importBatches.map((batch) => ({ ...batch, warnings: batch.warnings.map((warning) => ({ ...warning })) })),
};