import { Card, Statistic, Row, Col } from 'antd';
import { AimOutlined, CheckCircleOutlined, ExperimentOutlined, BulbOutlined, WarningOutlined } from '@ant-design/icons';
import type { ProjectState } from '../../lib/types';

interface StatsRowProps {
  statistics: ProjectState['statistics'];
  taskCount?: number;
  decisionCount?: number;
}

export function StatsRow({ statistics, taskCount, decisionCount }: StatsRowProps) {
  const items = [
    { title: '活跃目标', value: statistics.totalGoals - statistics.achievedGoals, icon: <AimOutlined />, color: '#1677ff' },
    { title: '进行任务', value: taskCount ?? 0, icon: <CheckCircleOutlined />, color: '#52c41a' },
    { title: '探索中', value: statistics.activeExplorations, icon: <ExperimentOutlined />, color: '#722ed1' },
    { title: '决策', value: decisionCount ?? 0, icon: <BulbOutlined />, color: '#faad14' },
    { title: '风险', value: statistics.openRisks, icon: <WarningOutlined />, color: statistics.openRisks > 0 ? '#ff4d4f' : '#8c8c8c' },
  ];

  return (
    <Row gutter={12}>
      {items.map(item => (
        <Col flex="1" key={item.title}>
          <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
            <Statistic
              title={item.title}
              value={item.value}
              prefix={item.icon}
              valueStyle={{ fontSize: 20, color: item.color }}
            />
          </Card>
        </Col>
      ))}
    </Row>
  );
}
