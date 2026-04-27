import { TabsHeader, useActiveTab } from '@/components/Tabs';
import AnalyticsPage from './AnalyticsPage';
import RecapPage from './RecapPage';
import ApiCostsPage from './ApiCostsPage';

const TABS = [
  { id: 'analytics', label: 'Analytics', icon: '📈' },
  { id: 'recap', label: 'Recap', icon: '📅' },
  { id: 'costs', label: 'Costs', icon: '💸' },
];

/** Unified performance view — full analytics, daily/weekly recap, and API
 *  cost tracking. Each tab renders its existing page component unchanged. */
export default function PerformancePage() {
  const active = useActiveTab(TABS, 'tab', 'analytics');

  return (
    <div>
      <TabsHeader tabs={TABS} paramKey="tab" defaultTab="analytics" variant="pills" />
      {active === 'analytics' && <AnalyticsPage />}
      {active === 'recap' && <RecapPage />}
      {active === 'costs' && <ApiCostsPage />}
    </div>
  );
}
