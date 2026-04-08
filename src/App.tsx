import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Scanner from './pages/Scanner';
import Opportunities from './pages/Opportunities';
import Analytics from './pages/Analytics';
import Positions from './pages/Positions';
import Settings from './pages/Settings';
import { ScannerProvider } from './context/ScannerContext';

const App = () => (
  <ScannerProvider>
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Scanner />} />
          <Route path="/opportunities" element={<Opportunities />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/positions" element={<Positions />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  </ScannerProvider>
);

export default App;
