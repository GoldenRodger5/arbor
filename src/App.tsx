import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import CommandCenter from './pages/CommandCenter';
import PositionsPage from './pages/PositionsPage';
import TradeHistory from './pages/TradeHistory';
import AnalyticsPage from './pages/AnalyticsPage';
import SettingsPage from './pages/SettingsPage';
import TradeReview from './pages/TradeReview';
import LiveFeed from './pages/LiveFeed';
import GamesPage from './pages/GamesPage';
import TodayPage from './pages/TodayPage';
import RecapPage from './pages/RecapPage';
import PreGameLabPage from './pages/PreGameLabPage';
import ApiCostsPage from './pages/ApiCostsPage';
import TradesPage from './pages/TradesPage';
import PerformancePage from './pages/PerformancePage';
import LivePage from './pages/LivePage';
import { ArborProvider } from './context/ArborContext';
import { Toaster } from '@/components/ui/sonner';
import InstallPrompt from './components/InstallPrompt';

const App = () => (
  <ArborProvider>
    <BrowserRouter>
      <Layout>
        <Routes>
          {/* === 5 PRIMARY ROUTES (sidebar + bottom tabs) === */}
          <Route path="/" element={<TodayPage />} />
          <Route path="/trades" element={<TradesPage />} />
          <Route path="/perf" element={<PerformancePage />} />
          <Route path="/live" element={<LivePage />} />
          <Route path="/settings" element={<SettingsPage />} />

          {/* === LEGACY DIRECT ROUTES (kept for back-compat + power users) === */}
          <Route path="/recap" element={<RecapPage />} />
          <Route path="/overview" element={<CommandCenter />} />
          <Route path="/positions" element={<PositionsPage />} />
          <Route path="/history" element={<TradeHistory />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/review" element={<TradeReview />} />
          {/* /live is now the unified LivePage; keep direct sub-routes too */}
          <Route path="/live-feed" element={<LiveFeed />} />
          <Route path="/games" element={<GamesPage />} />
          <Route path="/pregame-lab" element={<PreGameLabPage />} />
          <Route path="/costs" element={<ApiCostsPage />} />
        </Routes>
      </Layout>
      <InstallPrompt />
      <Toaster
        position="top-center"
        theme="dark"
        richColors
        closeButton
        toastOptions={{
          style: {
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
          },
        }}
      />
    </BrowserRouter>
  </ArborProvider>
);

export default App;
