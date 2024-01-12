import { Context } from 'egg';
import { getJwtTokenMsg } from './jwt';
import { BluBiuResponseCode } from '@/app/extend/context.type';

export const getCookieMessge = async (ctx:Context) => {
  const token = ctx.cookies.get('BLUBIUTOKEN');
  if (!token) return ctx.result(BluBiuResponseCode.NOLOGIN);

  const data = await getJwtTokenMsg<{userId:number}>(token);

  if (!data.userId) return ctx.result(BluBiuResponseCode.NOTFOUNDACCOUNT);

  return data.userId;
};
