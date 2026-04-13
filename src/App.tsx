import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import CommandCenter from './pages/CommandCenter';
import PositionsPage from './pages/PositionsPage';
import TradeHistory from './pages/TradeHistory';
import AnalyticsPage from './pages/AnalyticsPage';
import SettingsPage from './pages/SettingsPage';
import { ArborProvider } from './context/ArborContext';

const App = () => (
  <ArborProvider>
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<CommandCenter />} />
          <Route path="/positions" element={<PositionsPage />} />
          <Route path="/history" element={<TradeHistory />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  </ArborProvider>
);

export default App;
