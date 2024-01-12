export type ResponseMsg = {
  [key in BluBiuResponseCode]: string;
};

export enum BluBiuResponseCode{
  SUCCESS = 1000,
  QUERYERROR = 1001,
  APPIDNOUSE = 1002,
  LOGINERROR = 1003,
  ACCOUNTEXIST= 1004,
  NOLOGIN = 1005,
  NOTFOUNDACCOUNT = 1006
}
export const responseMsg:ResponseMsg = {
  [BluBiuResponseCode.SUCCESS]: '',
  [BluBiuResponseCode.QUERYERROR]: '请求参数错误',
  [BluBiuResponseCode.APPIDNOUSE]: 'APPID错误或者AppID未启用',
  [BluBiuResponseCode.LOGINERROR]: '登录账号或密码错误',
  [BluBiuResponseCode.ACCOUNTEXIST]: '该账号已被注',
  [BluBiuResponseCode.NOLOGIN]: '登录已过期',
  [BluBiuResponseCode.NOTFOUNDACCOUNT]: '没有找到用户信息',
};
