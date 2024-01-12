import { createModel } from '@rematch/core';
import type { RootModel } from '.';
import { getUserInfo } from '@/src/api';


const userModel = createModel<RootModel>()({
  state: {
    userInfo: {} as UserInfo,
    isLoading: false,
  },
  reducers: {
    resetUserInfo(){
      return {
        userInfo: {} as UserInfo,
        isGetUserInfo: false,
        isLoading: false,
      };
    },
    setUserInfo(state, payload: Partial<UserInfo>) {
      return {
        ...state,
        userInfo: {
          ...state.userInfo,
          ...payload,
        },
      };
    },
    setLoading(state, isLoading){
      return {
        ...state,
        isLoading,
      };
    },
  },
  effects: (dispatch) => ({
    async getUserInfo() {
      dispatch.user.setLoading(true);
      const { code, data } = await getUserInfo();
      if(code === 1000){
        dispatch.user.setUserInfo(data);
      }
      dispatch.user.setLoading(false);
    },
  }),
});

export default userModel;
