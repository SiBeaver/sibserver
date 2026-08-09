import { Card, Typography, Tag, Space } from 'antd';
import { ProgressBar } from '../shared/ProgressBar';
import { NodeTypeBadge } from '../shared/NodeTypeBadge';
import { HORIZON_LABELS, PRIORITY_COLORS } from '../../lib/constants';
import type { RoadmapItem } from '../../lib/types';
import { EmptyState } from '../shared/EmptyState';

interface RoadmapSectionProps {
  roadmap: RoadmapItem[];
}

function RoadmapNode({ item, depth }: { item: RoadmapItem; depth: number }) {
  const node = item.node;
  return (
    <div style={{ marginLeft: depth * 20, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <NodeTypeBadge type={node.type} />
        <Typography.Text strong={depth === 0} style={{ fontSize: depth === 0 ? 14 : 13 }}>
          {node.title}
        </Typography.Text>
        {node.horizon && <Tag>{HORIZON_LABELS[node.horizon] ?? node.horizon}</Tag>}
        {node.priority && <Tag color={PRIORITY_COLORS[node.priority]}>{node.priority}</Tag>}
      </div>
      {item.progress.total > 0 && (
        <div style={{ marginLeft: 4, marginTop: 4, maxWidth: 240 }}>
          <ProgressBar done={item.progress.done} total={item.progress.total} />
        </div>
      )}
      {item.children.map(child => (
        <RoadmapNode key={child.node.id} item={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export function RoadmapSection({ roadmap }: RoadmapSectionProps) {
  if (!roadmap.length) {
    return (
      <Card title="路线图" size="small">
        <EmptyState title="暂无目标" description="还没有定义任何目标" />
      </Card>
    );
  }

  return (
    <Card title="路线图" size="small">
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        {roadmap.map(item => (
          <RoadmapNode key={item.node.id} item={item} depth={0} />
        ))}
      </Space>
    </Card>
  );
}
