import { TabsHeader, useActiveTab } from '@/components/Tabs';
import PositionsPage from './PositionsPage';
import TradeHistory from './TradeHistory';
import TradeReview from './TradeReview';

const TABS = [
  { id: 'open', label: 'Open', icon: '📊' },
  { id: 'history', label: 'History', icon: '📋' },
  { id: 'review', label: 'Review', icon: '🧠' },
];

/** Unified trades view — open positions, settled history, and AI grading
 *  reviews in one place. Each tab renders its existing page component
 *  unchanged, so deep links still work and there's no behavioral risk. */
export default function TradesPage() {
  const active = useActiveTab(TABS, 'tab', 'open');

  return (
    <div>
      <TabsHeader tabs={TABS} paramKey="tab" defaultTab="open" variant="pills" />
      {active === 'open' && <PositionsPage />}
      {active === 'history' && <TradeHistory />}
      {active === 'review' && <TradeReview />}
    </div>
  );
}
