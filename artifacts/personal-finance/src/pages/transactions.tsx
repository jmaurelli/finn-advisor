import { Check, ChevronDown, Filter, Search, SlidersHorizontal, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, EmptyState, Modal, Money, PageHeader, Pill } from '@/components/finance-ui';
import { useFinance } from '@/domain/store';
import type { Transaction } from '@/domain/finance';

export default function Transactions() {
  const { transactions, categories, updateTransaction, rules, saveRule } = useFinance();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'uncategorized' | 'manual' | 'refunds' | 'transfers'>('all');
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [saved, setSaved] = useState(false);
  const filtered = useMemo(() => transactions.filter((txn) => {
    const matchesQuery = `${txn.merchant} ${txn.note ?? ''}`.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === 'all' || (filter === 'uncategorized' && txn.source === 'uncategorized') || (filter === 'manual' && txn.source === 'manual') || (filter === 'refunds' && txn.kind === 'refund') || (filter === 'transfers' && txn.kind === 'transfer');
    return matchesQuery && matchesFilter;
  }), [transactions, query, filter]);
  const categoryName = (id?: string) => categories.find((cat) => cat.id === id)?.name ?? 'Uncategorized';
  const saveCorrection = (categoryId: string, makeRule: boolean) => {
    if (!selected) return;
    updateTransaction(selected.id, { categoryId, source: 'manual', correctedAt: 'today' });
    if (makeRule) saveRule({ id: '', merchantPattern: selected.merchant.split(' ')[0], categoryId, enabled: true, matches: 1, updatedAt: 'Today' });
    setSaved(true);
    setTimeout(() => { setSelected(null); setSaved(false); }, 700);
  };
  return <div data-testid="page-transactions">
    <PageHeader eyebrow="The details" title="Transactions" description="A clear list of what moved. Correct a category once, and it stays yours." action={<Button variant="secondary" testId="button-export-transactions">Export view</Button>} />
    <div className="mb-6 grid gap-3 md:grid-cols-[1fr_auto]"><label className="relative block"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search merchants or notes" className="focus-ring h-11 w-full border border-border bg-card pl-10 pr-4 text-sm outline-none placeholder:text-muted-foreground" data-testid="input-search-transactions" /></label><div className="flex gap-2 overflow-x-auto pb-1"><span className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><Filter className="h-3.5 w-3.5" />Show</span>{(['all', 'uncategorized', 'manual', 'refunds', 'transfers'] as const).map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`focus-ring shrink-0 border px-3 py-2 text-xs font-semibold capitalize ${filter === item ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted'}`} data-testid={`button-filter-${item}`}>{item}</button>)}</div></div>
    <div className="mb-4 flex items-center justify-between text-xs text-muted-foreground"><span>{filtered.length} {filtered.length === 1 ? 'transaction' : 'transactions'}</span><span className="hidden items-center gap-1 sm:flex"><SlidersHorizontal className="h-3.5 w-3.5" />Newest first</span></div>
    {filtered.length === 0 ? <EmptyState title="Nothing matches that" description="Try another merchant, or clear the filter to see the full month." icon={<Search className="h-6 w-6" />} action={<Button variant="secondary" onClick={() => { setQuery(''); setFilter('all'); }} testId="button-clear-transaction-filters">Clear filters</Button>} /> : <div className="overflow-hidden border border-border bg-card"><div className="hidden grid-cols-[1.2fr_1fr_.8fr_.8fr_40px] gap-4 border-b border-border bg-muted/50 px-5 py-3 font-mono-finance text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:grid"><span>Merchant</span><span>Category</span><span>Date</span><span className="text-right">Amount</span><span /></div>{filtered.map((txn) => <TransactionRow key={txn.id} transaction={txn} categoryName={categoryName} onSelect={() => setSelected(txn)} />)}</div>}
    {selected && <CorrectionModal transaction={selected} categories={categories} rules={rules} onClose={() => setSelected(null)} onSave={saveCorrection} saved={saved} />}
  </div>;
}

function TransactionRow({ transaction, categoryName, onSelect }: { transaction: Transaction; categoryName: (id?: string) => string; onSelect: () => void }) {
  const sourceTone = transaction.source === 'manual' ? 'teal' : transaction.source === 'rule' ? 'blue' : 'yellow';
  return <button type="button" onClick={onSelect} className="focus-ring grid w-full grid-cols-1 gap-3 border-b border-border px-4 py-4 text-left transition last:border-0 hover:bg-muted/45 sm:grid-cols-[1.2fr_1fr_.8fr_.8fr_40px] sm:items-center sm:gap-4 sm:px-5" data-testid={`row-transaction-${transaction.id}`}><span className="flex min-w-0 items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center bg-muted font-semibold" style={{ color: transaction.source === 'uncategorized' ? undefined : 'hsl(var(--primary))' }}>{transaction.merchant.slice(0, 1)}</span><span className="min-w-0"><span className="block truncate text-sm font-semibold">{transaction.merchant}</span><span className="block text-xs text-muted-foreground sm:hidden">{new Date(transaction.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {transaction.kind}</span></span></span><span className="flex items-center gap-2 pl-12 sm:pl-0"><span className="text-sm">{categoryName(transaction.categoryId)}</span>{transaction.source !== 'uncategorized' && <Pill tone={sourceTone}>{transaction.source === 'manual' ? 'Corrected' : 'Rule'}</Pill>}</span><span className="hidden text-sm text-muted-foreground sm:block">{new Date(transaction.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span><span className={`text-right font-mono-finance text-sm ${transaction.kind === 'refund' ? 'text-primary' : transaction.kind === 'transfer' ? 'text-muted-foreground' : ''}`}><Money value={transaction.amount} signed /><span className="ml-2 text-[10px] font-sans uppercase text-muted-foreground">{transaction.kind === 'refund' ? 'refund' : transaction.kind === 'transfer' ? 'transfer' : ''}</span></span><span className="hidden justify-end sm:flex"><ChevronDown className="h-4 w-4 -rotate-90 text-muted-foreground" /></span></button>;
}

function CorrectionModal({ transaction, categories, rules, onClose, onSave, saved }: { transaction: Transaction; categories: ReturnType<typeof useFinance>['categories']; rules: ReturnType<typeof useFinance>['rules']; onClose: () => void; onSave: (categoryId: string, makeRule: boolean) => void; saved: boolean }) {
  const [categoryId, setCategoryId] = useState(transaction.categoryId ?? 'cat-uncat');
  const [makeRule, setMakeRule] = useState(false);
  const existingRule = rules.find((rule) => transaction.merchant.toLowerCase().includes(rule.merchantPattern.toLowerCase()));
  return <Modal title="Correct this transaction" description={`${transaction.merchant} · ${new Date(transaction.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`} onClose={onClose}>
    <div className="mb-6 flex items-center justify-between border border-border bg-muted/40 p-4"><div><p className="text-xs text-muted-foreground">Amount</p><p className="mt-1 font-mono-finance text-xl"><Money value={transaction.amount} signed /></p></div><Pill tone={transaction.kind === 'refund' ? 'teal' : transaction.kind === 'transfer' ? 'neutral' : 'yellow'}>{transaction.kind}</Pill></div>
    <label className="mb-2 block text-sm font-semibold" htmlFor="correction-category">Category</label><select id="correction-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="focus-ring mb-5 h-11 w-full border border-border bg-card px-3 text-sm outline-none" data-testid="select-correction-category">{categories.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}</select>
    {existingRule ? <div className="mb-5 flex gap-3 border border-[hsl(205_45%_56%/.25)] bg-[hsl(205_45%_56%/.08)] p-3 text-xs leading-5 text-[hsl(205_45%_30%)]"><Tag className="mt-0.5 h-4 w-4 shrink-0" /><span>This merchant has a rule for <strong>{categoryNameLocal(categories, existingRule.categoryId)}</strong>. Your correction will be manual and will not be overwritten.</span></div> : <label className="mb-6 flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" checked={makeRule} onChange={(event) => setMakeRule(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" data-testid="checkbox-create-rule" /><span><span className="font-semibold">Remember this for similar merchants</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Creates a reusable rule. You can edit or disable it anytime in Categories.</span></span></label>}
    <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose} testId="button-cancel-correction">Cancel</Button><Button onClick={() => onSave(categoryId, makeRule)} testId="button-save-correction">{saved ? <><Check className="h-4 w-4" />Saved</> : 'Save correction'}</Button></div>
  </Modal>;
}

function categoryNameLocal(categories: ReturnType<typeof useFinance>['categories'], id: string) { return categories.find((category) => category.id === id)?.name ?? 'Uncategorized'; }