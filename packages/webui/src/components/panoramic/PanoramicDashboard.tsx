import { Row, Col, Skeleton } from 'antd';
import useSWR from 'swr';
import { fetchProjectState, fetchRoadmap, fetchActivity } from '../../api/client';
import { StatsRow } from './StatsRow';
import { RoadmapSection } from './RoadmapSection';
import { WitemsSection } from './WitemsSection';
import { DecisionsSection } from './DecisionsSection';
import { ActivityTimeline } from './ActivityTimeline';
import type { RoadmapItem } from '../../lib/types';
import type { CognitiveNode } from '../../lib/types';

function extractActiveWitems(roadmap: RoadmapItem[]): CognitiveNode[] {
  const witems: CognitiveNode[] = [];
  function walk(items: RoadmapItem[]) {
    for (const item of items) {
      if (item.node.type === 'witem') witems.push(item.node);
      walk(item.children);
    }
  }
  walk(roadmap);
  return witems.filter(w => w.status !== 'achieved' && w.status !== 'abandoned' && w.status !== 'deferred');
}

interface PanoramicDashboardProps {
  slug: string;
}

export function PanoramicDashboard({ slug }: PanoramicDashboardProps) {
  const { data: state, isLoading: stateLoading } = useSWR(
    `${slug}/panoramic/state`,
    () => fetchProjectState(slug),
    { refreshInterval: 30_000 },
  );

  const { data: roadmapData, isLoading: roadmapLoading } = useSWR(
    `${slug}/panoramic/roadmap`,
    () => fetchRoadmap(slug, false, 3),
    { refreshInterval: 30_000 },
  );

  const { data: activityData, isLoading: activityLoading } = useSWR(
    `${slug}/panoramic/activity`,
    () => fetchActivity(slug, 15),
    { refreshInterval: 15_000 },
  );

  const roadmap = roadmapData?.roadmap ?? [];
  const activeWitems = extractActiveWitems(roadmap);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      {stateLoading ? <Skeleton active /> : state && (
        <StatsRow
          statistics={state.statistics}
          witemCount={activeWitems.length}
          decisionCount={state.recentDecisions?.length}
        />
      )}

      <div style={{ marginTop: 16 }}>
        {roadmapLoading ? <Skeleton active /> : (
          <RoadmapSection roadmap={roadmap} />
        )}
      </div>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={8}>
          {roadmapLoading ? <Skeleton active /> : (
            <WitemsSection witems={activeWitems} />
          )}
        </Col>
        <Col span={8}>
          {stateLoading ? <Skeleton active /> : (
            <DecisionsSection decisions={state?.recentDecisions ?? []} />
          )}
        </Col>
        <Col span={8}>
          {activityLoading ? <Skeleton active /> : (
            <ActivityTimeline events={activityData?.events ?? []} />
          )}
        </Col>
      </Row>
    </div>
  );
}
