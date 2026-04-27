import { TabsHeader, useActiveTab } from '@/components/Tabs';
import LiveFeed from './LiveFeed';
import GamesPage from './GamesPage';
import PreGameLabPage from './PreGameLabPage';

const TABS = [
  { id: 'feed', label: 'Feed', icon: '📡' },
  { id: 'games', label: 'Games', icon: '🎮' },
  { id: 'pregame', label: 'Pre-Game', icon: '🧪' },
];

/** Unified live view — real-time bot activity feed, current games being
 *  watched, and pre-game lab analysis. Each tab is the existing page. */
export default function LivePage() {
  const active = useActiveTab(TABS, 'tab', 'feed');

  return (
    <div>
      <TabsHeader tabs={TABS} paramKey="tab" defaultTab="feed" variant="pills" />
      {active === 'feed' && <LiveFeed />}
      {active === 'games' && <GamesPage />}
      {active === 'pregame' && <PreGameLabPage />}
    </div>
  );
}
