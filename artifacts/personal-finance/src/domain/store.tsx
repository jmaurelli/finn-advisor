import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { mockFinanceDataAccess } from './data-access';
import type { Budget, Category, CategoryRule, ImportBatch, Transaction } from './finance';

type FinanceStore = {
  transactions: Transaction[];
  budgets: Budget[];
  categories: Category[];
  rules: CategoryRule[];
  imports: ImportBatch[];
  updateTransaction: (id: string, patch: Partial<Transaction>) => void;
  saveBudget: (budget: Omit<Budget, 'id'> & { id?: string }) => void;
  saveCategory: (category: Omit<Category, 'id'> & { id?: string }) => void;
  saveRule: (rule: Omit<CategoryRule, 'id'> & { id?: string }) => void;
  toggleRule: (id: string) => void;
};

const FinanceContext = createContext<FinanceStore | null>(null);

export function FinanceProvider({ children }: { children: ReactNode }) {
  const [transactions, setTransactions] = useState(mockFinanceDataAccess.getTransactions);
  const [budgets, setBudgets] = useState(mockFinanceDataAccess.getBudgets);
  const [categories, setCategories] = useState(mockFinanceDataAccess.getCategories);
  const [rules, setRules] = useState(mockFinanceDataAccess.getRules);
  const value = useMemo<FinanceStore>(() => ({
    transactions,
    budgets,
    categories,
    rules,
    imports: mockFinanceDataAccess.getImports(),
    updateTransaction: (id, patch) => setTransactions((current) => current.map((txn) => txn.id === id ? { ...txn, ...patch } : txn)),
    saveBudget: (budget) => setBudgets((current) => budget.id ? current.map((item) => item.id === budget.id ? { ...item, ...budget } as Budget : item) : [...current, { ...budget, id: `budget-${Date.now()}` } as Budget]),
    saveCategory: (category) => setCategories((current) => category.id ? current.map((item) => item.id === category.id ? { ...item, ...category } as Category : item) : [...current, { ...category, id: `cat-${Date.now()}` } as Category]),
    saveRule: (rule) => setRules((current) => rule.id ? current.map((item) => item.id === rule.id ? { ...item, ...rule } as CategoryRule : item) : [...current, { ...rule, id: `rule-${Date.now()}` } as CategoryRule]),
    toggleRule: (id) => setRules((current) => current.map((rule) => rule.id === id ? { ...rule, enabled: !rule.enabled } : rule)),
  }), [transactions, budgets, categories, rules]);
  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>;
}

export function useFinance() {
  const value = useContext(FinanceContext);
  if (!value) throw new Error('useFinance must be used inside FinanceProvider');
  return value;
}

export const accounts = mockFinanceDataAccess.getAccounts();