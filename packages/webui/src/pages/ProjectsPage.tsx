import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Typography, Row, Col, Button, Empty, Spin, theme, Space, Modal, App } from 'antd';
import { PlusOutlined, FolderOutlined, LogoutOutlined, DeleteOutlined } from '@ant-design/icons';
import useSWR from 'swr';
import { fetchProjects, deleteProject } from '../api/client';
import { CreateProjectModal } from '../components/projects/CreateProjectModal';
import { clearToken } from '../lib/auth';
import type { ProjectMeta } from '../lib/types';

export function ProjectsPage() {
  const { data: projects, isLoading, mutate } = useSWR('projects', fetchProjects);
  const [modalOpen, setModalOpen] = useState(false);
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const { message } = App.useApp();

  const handleLogout = () => {
    clearToken();
    navigate('/login', { replace: true });
  };

  const handleDelete = (project: ProjectMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    Modal.confirm({
      title: '删除项目',
      content: `确定删除项目「${project.name}」？此操作不可撤销，将永久删除该项目下的所有数据。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteProject(project.slug);
          message.success(`已删除「${project.name}」`);
          mutate();
        } catch (err: any) {
          message.error(err?.message ?? '删除项目失败');
        }
      },
    });
  };

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: token.colorBgLayout, padding: '48px 64px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>项目</Typography.Title>
            <Typography.Text type="secondary">选择一个项目以查看认知图谱</Typography.Text>
          </div>
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
              新建项目
            </Button>
            <Button icon={<LogoutOutlined />} onClick={handleLogout}>登出</Button>
          </Space>
        </div>

        {(!projects || projects.length === 0) ? (
          <Empty description="暂无项目" />
        ) : (
          <Row gutter={[16, 16]}>
            {projects.map((project: ProjectMeta) => (
              <Col key={project.slug} xs={24} sm={12} lg={8}>
                <Card
                  hoverable
                  onClick={() => navigate(`/${project.slug}`)}
                  style={{ height: '100%', position: 'relative' }}
                >
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={(e) => handleDelete(project, e)}
                    style={{ position: 'absolute', top: 8, right: 8 }}
                  />
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: token.colorPrimaryBg,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <FolderOutlined style={{ fontSize: 18, color: token.colorPrimary }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Typography.Text strong style={{ fontSize: 15 }}>
                        {project.name}
                      </Typography.Text>
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {project.slug}
                        </Typography.Text>
                      </div>
                      {project.description && (
                        <Typography.Paragraph
                          type="secondary"
                          ellipsis={{ rows: 2 }}
                          style={{ margin: '8px 0 0', fontSize: 13 }}
                        >
                          {project.description}
                        </Typography.Paragraph>
                      )}
                    </div>
                  </div>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </div>

      <CreateProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => { mutate(); setModalOpen(false); }}
      />
    </div>
  );
}
