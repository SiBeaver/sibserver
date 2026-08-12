import { Card, List, Tag } from 'antd';
import { StatusBadge } from '../shared/StatusBadge';
import { TimeAgo } from '../shared/TimeAgo';
import { PRIORITY_COLORS } from '../../lib/constants';
import { EmptyState } from '../shared/EmptyState';
import type { CognitiveNode } from '../../lib/types';

interface WitemsSectionProps {
  witems: CognitiveNode[];
}

export function WitemsSection({ witems }: WitemsSectionProps) {
  if (!witems.length) {
    return (
      <Card title="在办工作项" size="small" style={{ height: '100%' }}>
        <EmptyState title="无在办工作项" description="暂无进行中的承诺" />
      </Card>
    );
  }

  return (
    <Card title="在办工作项" size="small" style={{ height: '100%' }}>
      <List
        size="small"
        dataSource={witems.slice(0, 8)}
        renderItem={witem => (
          <List.Item style={{ padding: '6px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
              <StatusBadge status={witem.status} />
              <span style={{ flex: 1, fontSize: 13 }}>{witem.title}</span>
              {witem.priority && <Tag color={PRIORITY_COLORS[witem.priority]} style={{ marginRight: 0 }}>{witem.priority}</Tag>}
              <TimeAgo date={witem.updatedAt} />
            </div>
          </List.Item>
        )}
      />
    </Card>
  );
}
