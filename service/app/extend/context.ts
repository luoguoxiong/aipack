import { Context } from 'egg';
import { BluBiuResponseCode, responseMsg } from './context.type';


export interface BluBiuResponse<T>{
  code: BluBiuResponseCode
  message:string
  data:T
}

export default {
  result(code:BluBiuResponseCode, data?:any) {
    const ctx = this as Context;
    ctx.body = {
      code,
      message: responseMsg[code],
      data,
    };
  },

  success(data?:any) {
    this.result(BluBiuResponseCode.SUCCESS, data);
  },

  queryError() {
    this.result(BluBiuResponseCode.QUERYERROR);
  },
};

