import { Row, Col, Skeleton } from 'antd';
import useSWR from 'swr';
import { fetchProjectState, fetchRoadmap, fetchActivity } from '../../api/client';
import { StatsRow } from './StatsRow';
import { RoadmapSection } from './RoadmapSection';
import { TasksSection } from './TasksSection';
import { ExplorationsSection } from './ExplorationsSection';
import { DecisionsSection } from './DecisionsSection';
import { ActivityTimeline } from './ActivityTimeline';
import type { RoadmapItem } from '../../lib/types';
import type { CognitiveNode } from '../../lib/types';

function extractTasks(roadmap: RoadmapItem[]): CognitiveNode[] {
  const tasks: CognitiveNode[] = [];
  function walk(items: RoadmapItem[]) {
    for (const item of items) {
      if (item.node.type === 'task') tasks.push(item.node);
      walk(item.children);
    }
  }
  walk(roadmap);
  return tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');
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
  const tasks = extractTasks(roadmap);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      {stateLoading ? <Skeleton active /> : state && (
        <StatsRow
          statistics={state.statistics}
          taskCount={tasks.length}
          decisionCount={state.recentDecisions?.length}
        />
      )}

      <div style={{ marginTop: 16 }}>
        {roadmapLoading ? <Skeleton active /> : (
          <RoadmapSection roadmap={roadmap} />
        )}
      </div>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={12}>
          {roadmapLoading ? <Skeleton active /> : (
            <TasksSection tasks={tasks} />
          )}
        </Col>
        <Col span={12}>
          {stateLoading ? <Skeleton active /> : (
            <ExplorationsSection explorations={state?.activeExplorations ?? []} />
          )}
        </Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={12}>
          {stateLoading ? <Skeleton active /> : (
            <DecisionsSection decisions={state?.recentDecisions ?? []} />
          )}
        </Col>
        <Col span={12}>
          {activityLoading ? <Skeleton active /> : (
            <ActivityTimeline events={activityData?.events ?? []} />
          )}
        </Col>
      </Row>
    </div>
  );
}
