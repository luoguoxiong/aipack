import React, { useEffect } from 'react';
import { Empty, Button } from 'antd';
import { PlusCircleFilled } from '@ant-design/icons';
import { AppItem } from './components/appItem';
import styles from './index.module.less';
import { useAppStore } from '@/src/hooks';
const Home = () => {
  const { apps, appDispatch } = useAppStore();

  useEffect(() => {
    appDispatch.getAppList();
  }, []);

  return (
    <>
      {apps.length === 0 ? (
        <div className={styles.empty}>
          <Empty description={
            <>
              <span>您还没有应用，快去创建应用吧！</span>
              <br />
              <br />
              <Button
                type="primary"
                onClick={() => {
                  appDispatch.updateAddModalStatus(true);
                }}
                icon={<PlusCircleFilled />}>立即创建</Button>
            </>
          }/>
        </div>
      )
        : <div className={styles['app-wrap']}>
          {
            apps.map((item) => <AppItem
              key={item.id}
              appInfo={item} />)
          }
        </div>
      }
    </>
  );

};

export default Home;
