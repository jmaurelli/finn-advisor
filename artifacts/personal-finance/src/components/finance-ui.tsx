import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function Money({ value, signed = false, className = '' }: { value: number; signed?: boolean; className?: string }) {
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  return <span className={className}>{sign}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p className="mb-2 font-mono-finance text-[11px] uppercase tracking-[0.18em] text-primary" data-testid={`text-eyebrow-${eyebrow.toLowerCase().replaceAll(' ', '-')}`}>{eyebrow}</p>
      <h1 className="font-display text-4xl tracking-[-0.03em] text-foreground sm:text-5xl" data-testid={`text-page-title-${title.toLowerCase().replaceAll(' ', '-')}`}>{title}</h1>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
    {action}
  </header>;
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="mb-3 flex items-center justify-between"><h2 className="font-mono-finance text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{children}</h2>{action}</div>;
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'teal' | 'yellow' | 'red' | 'blue' }) {
  const tones = {
    neutral: 'bg-muted text-muted-foreground',
    teal: 'bg-[hsl(181_48%_34%/.12)] text-primary',
    yellow: 'bg-[hsl(43_92%_69%/.28)] text-[hsl(35_55%_29%)]',
    red: 'bg-[hsl(2_64%_51%/.11)] text-destructive',
    blue: 'bg-[hsl(205_45%_56%/.13)] text-[hsl(205_45%_38%)]',
  };
  return <span className={`inline-flex items-center px-2.5 py-1 text-[11px] font-semibold ${tones[tone]}`}>{children}</span>;
}

export function ProgressBar({ value, tone = 'teal' }: { value: number; tone?: 'teal' | 'yellow' | 'red' }) {
  const color = tone === 'red' ? 'bg-destructive' : tone === 'yellow' ? 'bg-[hsl(43_78%_57%)]' : 'bg-primary';
  return <div className="h-2 overflow-hidden bg-muted"><div className={`h-full ${color} transition-all duration-500`} style={{ width: `${Math.min(value, 100)}%` }} /></div>;
}

export function Modal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[hsl(188_27%_17%/.35)] p-0 backdrop-blur-[2px] sm:items-center sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="max-h-[92dvh] w-full overflow-y-auto border border-border bg-card p-6 shadow-2xl sm:max-w-lg sm:p-8" role="dialog" aria-modal="true" aria-label={title}>
      <div className="mb-7 flex items-start justify-between gap-5">
        <div><h2 className="font-display text-3xl tracking-[-0.02em]">{title}</h2>{description && <p className="mt-2 text-sm leading-5 text-muted-foreground">{description}</p>}</div>
        <button type="button" className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center border border-border text-muted-foreground hover:bg-muted" onClick={onClose} aria-label="Close dialog" data-testid="button-close-dialog"><X className="h-4 w-4" /></button>
      </div>
      {children}
    </div>
  </div>;
}

export function EmptyState({ title, description, action, icon }: { title: string; description: string; action?: ReactNode; icon?: ReactNode }) {
  return <div className="surface-grid flex min-h-64 flex-col items-center justify-center border border-dashed border-border px-6 py-12 text-center">{icon && <div className="mb-4 text-primary">{icon}</div>}<h3 className="font-display text-2xl">{title}</h3><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>{action && <div className="mt-5">{action}</div>}</div>;
}

export function Button({ children, onClick, variant = 'primary', type = 'button', className = '', disabled = false, testId = 'button-action' }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; type?: 'button' | 'submit'; className?: string; disabled?: boolean; testId?: string }) {
  const styles = {
    primary: 'bg-primary text-primary-foreground hover:brightness-110',
    secondary: 'border border-border bg-card text-foreground hover:bg-muted',
    ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
    danger: 'border border-[hsl(2_64%_51%/.28)] text-destructive hover:bg-[hsl(2_64%_51%/.08)]',
  };
  return <button type={type} onClick={onClick} disabled={disabled} data-testid={testId} className={`focus-ring inline-flex min-h-10 items-center justify-center gap-2 px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]} ${className}`}>{children}</button>;
}