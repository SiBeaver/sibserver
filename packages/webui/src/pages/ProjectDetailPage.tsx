import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Typography, Button, Badge, theme, Space, Segmented } from 'antd';
import { ReloadOutlined, ArrowLeftOutlined, MessageOutlined, LogoutOutlined } from '@ant-design/icons';
import { useSWRConfig } from 'swr';
import useSWR from 'swr';
import { HelmView } from '../components/helm/HelmView';
import { PanoramicDashboard } from '../components/panoramic';
import { ChatPanel } from '../components/chat/ChatPanel';
import { clearToken } from '../lib/auth';
import { fetchHelmSignals } from '../api/client';
import type { Tab } from '../lib/constants';

const TAB_OPTIONS: { label: string; value: Tab }[] = [
  { label: '全景', value: 'panoramic' },
  { label: '信号', value: 'helm' },
];

export function ProjectDetailPage() {
  const { slug, tab } = useParams<{ slug: string; tab: string }>();
  const navigate = useNavigate();
  const { mutate } = useSWRConfig();
  const [spinning, setSpinning] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const { token } = theme.useToken();

  const activeTab = TAB_OPTIONS.some(t => t.value === tab) ? (tab as Tab) : 'panoramic';

  const { data: helmData } = useSWR(
    `${slug}/helm-count`,
    () => fetchHelmSignals(slug!),
    { refreshInterval: 30_000 },
  );
  const alertCount = helmData?.signals?.length ?? 0;

  const handleRefresh = () => {
    setSpinning(true);
    mutate(() => true, undefined, { revalidate: true });
    setTimeout(() => setSpinning(false), 600);
  };

  const handleLogout = () => {
    clearToken();
    navigate('/login', { replace: true });
  };

  const handleToggleChat = () => {
    setChatOpen(!chatOpen);
  };

  const handleTabChange = (value: string | number) => {
    navigate(`/${slug}/${value}`, { replace: true });
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: token.colorBgLayout }}>
      <div style={{
        height: 48,
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        flexShrink: 0,
      }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/')} />
        <Typography.Title level={5} style={{ margin: '0 16px' }}>{slug}</Typography.Title>
        <Segmented
          options={TAB_OPTIONS}
          value={activeTab}
          onChange={handleTabChange}
          size="small"
        />
        <div style={{ flex: 1 }} />
        <Space size={4}>
          {alertCount > 0 && <Badge count={alertCount} size="small" />}
          <Button type="text" size="small" icon={<ReloadOutlined spin={spinning} />} onClick={handleRefresh} />
          <Button type="text" size="small" icon={<MessageOutlined />} onClick={handleToggleChat} />
          <Button type="text" size="small" icon={<LogoutOutlined />} onClick={handleLogout} />
        </Space>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto', padding: chatOpen ? 24 : 32 }}>
          {activeTab === 'panoramic' && <PanoramicDashboard slug={slug!} />}
          {activeTab === 'helm' && <HelmView slug={slug!} />}
        </div>

        {chatOpen && (
          <div style={{
            width: 380,
            borderLeft: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
            overflow: 'auto',
            flexShrink: 0,
          }}>
            <div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column' }}>
              <Typography.Text strong style={{ marginBottom: 12 }}>对话</Typography.Text>
              <ChatPanel slug={slug!} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
