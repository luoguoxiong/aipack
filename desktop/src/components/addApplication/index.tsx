import React, { useState } from 'react';
import { Modal, Form, Radio, Input, message } from 'antd';
import { createApp } from '@/src/api';
import { AppTypes, AppType } from '@/src/constants';
import { useAppStore } from '@/src/hooks';

interface AddApplicationIn{
  open: boolean;
  onClose: () => void;
}
export const AddApplication: React.FC<AddApplicationIn> = ({ open, onClose }) => {
  const [form] = Form.useForm();

  const { appDispatch } = useAppStore();

  const [loading, setLoading] = useState(false);

  return (
    <Modal
      open={open}
      destroyOnClose
      onOk={async() => {
        await form.validateFields();
        setLoading(true);
        await createApp(form.getFieldsValue());
        await appDispatch.getAppList();
        setLoading(false);
        message.success('应用成功创建！');
        onClose();
      }}
      onCancel={onClose}
      okButtonProps={{
        loading,
      }}
      title="创建应用">

      <Form
        form={form}
      >
        <Form.Item
          name="appName"
          label="应用名称"
          rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item
          name="appType"
          label="应用类型"
          initialValue={AppType.WEB}
          rules={[{ required: true }]}>
          <Radio.Group>
            {AppTypes.map(((item) =>
              <Radio
                value={item.value}
                disabled={item.value !== AppType.WEB}
                key={item.value}>
                {item.label}
              </Radio>))}
          </Radio.Group>
        </Form.Item>
      </Form>
    </Modal>
  );
};
