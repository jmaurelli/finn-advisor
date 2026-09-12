import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '@/components/app-shell';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FinanceProvider } from '@/domain/store';
import Budgets from '@/pages/budgets';
import Categories from '@/pages/categories';
import Imports from '@/pages/imports';
import NotFound from '@/pages/not-found';
import Overview from '@/pages/overview';
import Settings from '@/pages/settings';
import Transactions from '@/pages/transactions';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <AppShell>
        <Switch>
        <Route path="/" component={Overview} />
        <Route path="/transactions" component={Transactions} />
        <Route path="/budgets" component={Budgets} />
        <Route path="/categories" component={Categories} />
        <Route path="/imports" component={Imports} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
        </Switch>
      </AppShell>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  useEffect(() => {
    document.title = 'Tallywell · Personal finance, with room to breathe';
    const description = document.querySelector('meta[name="description"]') ?? document.createElement('meta');
    description.setAttribute('name', 'description');
    description.setAttribute('content', 'A quiet personal space to understand where your money went.');
    if (!description.parentNode) document.head.appendChild(description);
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <FinanceProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
        </FinanceProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
