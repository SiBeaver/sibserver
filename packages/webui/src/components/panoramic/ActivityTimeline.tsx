import { Card, List, Tag } from 'antd';
import { TimeAgo } from '../shared/TimeAgo';
import { NodeTypeBadge } from '../shared/NodeTypeBadge';
import { EmptyState } from '../shared/EmptyState';
import type { EventRecord } from '../../lib/types';
import type { CognitiveNode } from '../../lib/types';

interface ActivityTimelineProps {
  events: EventRecord[];
}

const OP_LABELS: Record<string, string> = {
  define_witem: '定义工作项',
  decompose_witem: '分解工作项',
  update_witem_status: '更新工作项',
  record_decision: '记录决策',
  record_knowledge: '记录知识',
  identify_risk: '识别风险',
  update_risk: '更新风险',
  define_requirement: '定义需求',
  update_requirement_status: '更新需求',
  register_tech_debt: '记录技术债',
  delete_node: '删除节点',
};

export function ActivityTimeline({ events }: ActivityTimelineProps) {
  if (!events.length) {
    return (
      <Card title="动态" size="small" style={{ height: '100%' }}>
        <EmptyState title="暂无动态" description="还没有任何活动" />
      </Card>
    );
  }

  return (
    <Card title="动态" size="small" style={{ height: '100%' }}>
      <List
        size="small"
        dataSource={events.slice(0, 12)}
        renderItem={event => (
          <List.Item style={{ padding: '4px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', fontSize: 12 }}>
              <Tag style={{ fontSize: 11, lineHeight: '18px', margin: 0 }}>
                {OP_LABELS[event.operation] ?? event.operation}
              </Tag>
              {event.nodeType && <NodeTypeBadge type={event.nodeType as CognitiveNode['type']} />}
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(event.payload as any)?.title ?? event.nodeId?.slice(0, 8)}
              </span>
              <TimeAgo date={event.timestamp} />
            </div>
          </List.Item>
        )}
      />
    </Card>
  );
}
