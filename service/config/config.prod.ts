import { EggAppConfig, EggAppInfo, PowerPartial } from 'egg';

export default (appInfo: EggAppInfo) => {
  const config = {} as PowerPartial<EggAppConfig>;
  
  config.keys = appInfo.name + '_1702282822597_3491';

  return config;
};
