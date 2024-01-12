import React, { useState, useEffect }from 'react';
import dayjs from 'dayjs';
import { CopyOutlined } from '@ant-design/icons';
import { Button, Tooltip, message } from 'antd';
import cls from 'classnames';
import { useNavigate } from 'react-router';
import styles from './index.module.less';
import { PeropleCounter, Loading, NewUserLine } from '@/src/components';
import { updateAppStatus } from '@/src/api';
import { copyTextToClipboard } from '@/src/utils';
import { useAppStore, useAppInfo } from '@/src/hooks';

interface AppItemIn{
  appInfo: AppInfo;
}
export const AppItem: React.FC<AppItemIn> = ({ appInfo }) => {

  const { appDispatch } = useAppStore();

  const { appStatus, loading } = useAppInfo(appInfo.appId);

  const navigate = useNavigate();

  const { activeUsers, allUsers, newUsers, lastWeekActiveUers } = appStatus;

  const updateApp = async() => {
    await updateAppStatus({
      appId: appInfo.appId,
      id: appInfo.id,
      status: appInfo.status === 1 ? 0 : 1,
    });
    await appDispatch.getAppList();
    message.success(appInfo.status === 1 ? '已停用' : '已启用');
  };

  return (
    <div className={styles.content}>
      {
        loading
          ? <Loading style={{ height: 150 }} />
          : <>
            <div className={styles.title}>
              {appInfo.appName}

              <Tooltip
                placement="top"
                title="复制AppId" >
                <CopyOutlined
                  className={styles.icon}
                  onClick={() => {
                    copyTextToClipboard(appInfo.appId);
                  }} />
              </Tooltip>
              <span
                className={styles.insert}
                onClick={() => {
                  appDispatch.updateActive(appInfo.appId);
                  navigate('/visitorStats');
                }}>进入</span>
              {appInfo.status === 1 && (
                <span
                  className={cls(styles.insert, styles.stop)}
                  onClick={() => {
                    updateApp();
                  }}>停用</span>
              )}
            </div>
            <div className={styles.user}>
              <div>
                <span className={styles['sub-title']}>用户总数</span>
                <span className={styles.value}>
                  <PeropleCounter count={allUsers} />
                </span>
              </div>
              <div>
                <span className={styles['sub-title']}>今日活跃</span>
                <span className={styles.value}>
                  <PeropleCounter count={activeUsers} />
                </span>
              </div>
              <div>
                <span className={styles['sub-title']}>新用户数</span>
                <span className={styles.value}>
                  <PeropleCounter count={newUsers} />
                </span>
              </div>
              <div>
                <span className={styles['sub-title']}>一周活跃趋势</span>
                <span className={styles.value}>
                  <NewUserLine data={lastWeekActiveUers} />
                </span>
              </div>
            </div>
          </>
      }
      {
        appInfo.status !== 1 && (
          <div className={styles.mask}>
            <span style={{ 'textAlign': 'center', color: 'white' }}>
              <div className={styles.openText}>应用已关闭，点击重新开启</div>
              <Button
                type="primary"
                onClick={updateApp}>立即开启</Button>
            </span>
          </div>
        )
      }
    </div>
  );
};
