import { useState } from 'react';
import { Modal, Form, Input, App } from 'antd';
import { createProject } from '../../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateProjectModal({ open, onClose, onCreated }: Props) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const { message } = App.useApp();

  const handleOk = async () => {
    let values;
    try {
      values = await form.validateFields();
    } catch {
      return; // 校验失败，表单已就地显示错误
    }
    setLoading(true);
    try {
      await createProject(values);
      form.resetFields();
      onCreated();
    } catch (err: any) {
      message.error(err?.message ?? '创建项目失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="新建项目"
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={loading}
      okText="创建"
      cancelText="取消"
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item
          name="name"
          label="项目名称"
          rules={[{ required: true, message: '请输入项目名称' }]}
        >
          <Input placeholder="例：代收代付平台" />
        </Form.Item>
        <Form.Item
          name="slug"
          label="项目标识"
          rules={[
            { required: true, message: '请输入项目标识' },
            { pattern: /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, message: '小写字母+数字+连字符' },
          ]}
          extra="用于 URL 和 MCP 工具参数，如 trsjucpai"
        >
          <Input placeholder="例：trsjucpai" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input.TextArea rows={3} placeholder="可选" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
