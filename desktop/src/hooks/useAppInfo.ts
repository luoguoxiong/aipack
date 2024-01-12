import { useState, useEffect }from 'react';
import dayjs from 'dayjs';
import { getAllUsers, getDayActiveUsers, getNewUsers } from '@/src/api';

export const useAppInfo = (appId: string) => {

  const [loading, setLoading] = useState(false);

  const [appStatus, setInfo] = useState({
    activeUsers: 0,
    allUsers: 0,
    newUsers: 0,
    lastWeekActiveUers: [],
  });

  const getLastWeekActiveUsers = async(appId: string) => {
    const week = [];
    let day = 7;
    while(day >= 0){
      week.push(getDayActiveUsers({ appId, date: dayjs().add(-day, 'day').format('YYYY-MM-DD') }));
      day--;
    }
    return await Promise.all(week);
  };
  const getAppInfo = async() => {
    setLoading(true);
    const [activeUsers, allUsers, newUsers, weeks ] = await Promise.all([
      getDayActiveUsers({ appId }),
      getAllUsers({ appId }),
      getNewUsers({ appId }),
      getLastWeekActiveUsers(appId),
    ]);
    setLoading(false);
    setInfo({
      activeUsers: activeUsers.data,
      allUsers: allUsers.data,
      newUsers: newUsers.data,
      lastWeekActiveUers: weeks.map((item) => item.data),
    });
  };

  useEffect(() => {
    getAppInfo();
  }, [appId]);

  return {
    appStatus,
    loading,
  };

};
