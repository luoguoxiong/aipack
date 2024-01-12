import { createModel } from '@rematch/core';
import type { RootModel } from '.';
import { getAppList } from '@/src/api';

const userModel = createModel<RootModel>()({
  state: {
    apps: [] as AppInfo[],
    isLoading: true,
    showAddModal: false,
    active: '',
  },
  reducers: {
    updateAppModel(state, newState){
      return {
        ...state,
        ...newState,
      };
    },
    updateActive(state, active){
      return {
        ...state,
        active,
      };
    },
    updateAddModalStatus(state, show){
      return {
        ...state,
        showAddModal: show,
      };
    },
  },
  effects: (dispatch) => ({
    async getAppList() {
      dispatch.app.updateAppModel({
        isLoading: true,
      });
      const { code, data } = await getAppList();
      if(data.length === 1){
        dispatch.app.updateAppModel({
          isLoading: false,
          apps: code === 1000 ? data : [],
          active: data[0].appId,
        });
      }else{
        dispatch.app.updateAppModel({
          isLoading: false,
          apps: code === 1000 ? data : [],
        });
      }
    },
    // 首次进入应用
    async getAppListOnce(){
      dispatch.app.updateAppModel({
        isLoading: true,
      });
      const { code, data } = await getAppList();
      dispatch.app.updateAppModel({
        isLoading: false,
        apps: code === 1000 ? data : [],
        active: data.length > 0 ? data[0].appId : '',
      });
    },
  }),
});

export default userModel;
