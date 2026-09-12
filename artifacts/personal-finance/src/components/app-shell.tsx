import { BarChart3, BookOpen, ChevronDown, CircleDollarSign, FileUp, ListFilter, Menu, Settings, Tags, WalletCards, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';

const nav = [
  { href: '/', label: 'Overview', icon: BarChart3 },
  { href: '/transactions', label: 'Transactions', icon: ListFilter },
  { href: '/budgets', label: 'Budgets', icon: WalletCards },
  { href: '/categories', label: 'Categories', icon: Tags },
  { href: '/imports', label: 'Imports', icon: FileUp },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const close = () => setMobileOpen(false);
  return <div className="min-h-[100dvh] bg-background">
    <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-sidebar px-4 py-5 text-sidebar-foreground transition-transform duration-200 lg:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="flex items-center justify-between px-3 pb-10">
        <Link href="/" onClick={close} className="focus-ring flex items-center gap-3" data-testid="link-logo"><span className="flex h-9 w-9 items-center justify-center bg-sidebar-primary text-sidebar-primary-foreground"><CircleDollarSign className="h-5 w-5" /></span><span className="font-display text-xl tracking-[-0.02em]">Tallywell</span></Link>
        <button type="button" className="focus-ring text-sidebar-foreground lg:hidden" onClick={close} aria-label="Close navigation" data-testid="button-close-navigation"><X className="h-5 w-5" /></button>
      </div>
      <p className="px-3 pb-3 font-mono-finance text-[10px] uppercase tracking-[0.18em] text-sidebar-foreground/50">Your money, in context</p>
      <nav className="space-y-1" aria-label="Primary navigation">
        {nav.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={close} data-testid={`link-nav-${label.toLowerCase()}`} className={`focus-ring flex items-center gap-3 px-3 py-3 text-sm transition ${location === href ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground'}`}><Icon className="h-[18px] w-[18px]" /><span>{label}</span>{href === '/transactions' && <span className="ml-auto bg-sidebar-primary px-1.5 py-0.5 font-mono-finance text-[10px] text-sidebar-primary-foreground">2</span>}</Link>)}
      </nav>
      <div className="mt-auto">
        <div className="mb-4 border-t border-sidebar-border pt-4">
          <Link href="/settings" onClick={close} data-testid="link-nav-settings" className={`focus-ring flex items-center gap-3 px-3 py-3 text-sm transition ${location === '/settings' ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground'}`}><Settings className="h-[18px] w-[18px]" />Settings</Link>
        </div>
        <div className="flex items-center gap-3 border border-sidebar-border bg-sidebar-accent/40 px-3 py-3"><span className="flex h-8 w-8 items-center justify-center bg-sidebar-primary font-display text-sm text-sidebar-primary-foreground">AM</span><div className="min-w-0"><p className="truncate text-sm">Alex Morgan</p><p className="truncate text-[11px] text-sidebar-foreground/50">Personal space</p></div><ChevronDown className="ml-auto h-4 w-4 text-sidebar-foreground/50" /></div>
      </div>
    </aside>
    {mobileOpen && <button className="fixed inset-0 z-30 bg-foreground/30 lg:hidden" onClick={close} aria-label="Close navigation overlay" data-testid="button-navigation-overlay" />}
    <main className="min-h-[100dvh] lg:pl-64">
      <div className="flex items-center justify-between border-b border-border bg-background/90 px-5 py-4 backdrop-blur-sm lg:hidden"><button type="button" className="focus-ring" onClick={() => setMobileOpen(true)} aria-label="Open navigation" data-testid="button-open-navigation"><Menu className="h-5 w-5" /></button><Link href="/" className="font-display text-xl" data-testid="link-mobile-logo">Tallywell</Link><BookOpen className="h-5 w-5 text-primary" /></div>
      <div className="mx-auto max-w-[1440px] px-5 py-7 sm:px-8 lg:px-12 lg:py-10">{children}</div>
    </main>
  </div>;
}