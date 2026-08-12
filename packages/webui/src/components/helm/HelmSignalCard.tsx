import { createElement } from 'react';
import { Card, Tag, Typography, Space, Button, Popconfirm, message } from 'antd';
import {
  FileTextOutlined, WarningOutlined, ThunderboltOutlined,
  StopOutlined, ClockCircleOutlined, BranchesOutlined,
} from '@ant-design/icons';
import { executeOperation } from '../../api/client';
import type { HelmSignal, HelmSignalType } from '../../api/client';
import { TimeAgo } from '../shared/TimeAgo';

const SIGNAL_CONFIG: Record<HelmSignalType, { icon: any; color: string; label: string }> = {
  proposed_requirement: { icon: FileTextOutlined, color: 'blue', label: '待确认需求' },
  revision_needed: { icon: WarningOutlined, color: 'orange', label: '需要修订' },
  knowledge_conflict: { icon: ThunderboltOutlined, color: 'red', label: '知识冲突' },
  blocker: { icon: StopOutlined, color: 'red', label: '阻塞' },
  stale: { icon: ClockCircleOutlined, color: 'gold', label: '停滞' },
  goal_review: { icon: BranchesOutlined, color: 'green', label: '方向确认' },
};

const URGENCY_COLORS: Record<string, string> = {
  critical: '#ff4d4f',
  high: '#fa8c16',
  medium: '#faad14',
  low: '#8c8c8c',
};

interface Props {
  signal: HelmSignal;
  slug: string;
  onAction: () => void;
}

export function HelmSignalCard({ signal, slug, onAction }: Props) {
  const config = SIGNAL_CONFIG[signal.type];

  const handleAction = async (operation: string, input: Record<string, unknown>) => {
    try {
      await executeOperation(slug, operation, input);
      message.success('操作成功');
      onAction();
    } catch (e: any) {
      message.error(e.message || '操作失败');
    }
  };

  const renderActions = () => {
    switch (signal.type) {
      case 'proposed_requirement':
        return (
          <Space size={4}>
            <Button size="small" type="primary" onClick={() =>
              handleAction('update-requirement-status', { requirement_id: signal.node.id, new_status: 'accepted' })
            }>确认</Button>
            <Popconfirm title="确认驳回？" onConfirm={() =>
              handleAction('update-requirement-status', { requirement_id: signal.node.id, new_status: 'deprecated' })
            }>
              <Button size="small" danger>驳回</Button>
            </Popconfirm>
          </Space>
        );
      case 'revision_needed':
        return (
          <Button size="small" onClick={() =>
            handleAction('update-requirement-status', { requirement_id: signal.node.id, new_status: 'accepted' })
          }>重新接受</Button>
        );
      case 'knowledge_conflict':
        return null;
      case 'blocker':
        return (
          <Space size={4}>
            <Button size="small" onClick={() => {
              const op = signal.node.type === 'risk' ? 'update-risk' : 'update-requirement-status';
              const input = signal.node.type === 'risk'
                ? { risk_id: signal.node.id, new_status: 'accepted' }
                : { requirement_id: signal.node.id, new_status: 'deprecated' };
              handleAction(op, input);
            }}>绕行</Button>
          </Space>
        );
      case 'stale':
        return (
          <Popconfirm title="确认放弃？" onConfirm={() => {
            const op = signal.node.type === 'witem' ? 'update-witem-status' : 'update-risk';
            const input = signal.node.type === 'witem'
              ? { witem_id: signal.node.id, new_status: 'abandoned' }
              : { risk_id: signal.node.id, new_status: 'accepted' };
            handleAction(op, input);
          }}>
            <Button size="small" danger>放弃</Button>
          </Popconfirm>
        );
      case 'goal_review':
        return null;
      default:
        return null;
    }
  };

  return (
    <Card
      size="small"
      style={{
        borderLeft: `3px solid ${URGENCY_COLORS[signal.urgency]}`,
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Space size={8} style={{ marginBottom: 4 }}>
            {createElement(config.icon, { style: { color: URGENCY_COLORS[signal.urgency] } })}
            <Tag color={config.color} style={{ marginRight: 0 }}>{config.label}</Tag>
            <Typography.Text strong style={{ fontSize: 14 }}>{signal.title}</Typography.Text>
          </Space>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {signal.summary}
            </Typography.Text>
          </div>
          {signal.context.nodes.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                关联：{signal.context.nodes.map(n => n.title).join('、')}
              </Typography.Text>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <TimeAgo date={signal.timestamp} />
          {renderActions()}
        </div>
      </div>
    </Card>
  );
}
