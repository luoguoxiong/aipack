import http from '../../http'
import { all, call, put, takeLatest } from 'redux-saga/effects';
import actionTypes from '../actions/actionTypes'
import { requestBefore } from "./request";
export function* catalogInit(action) {
  try {
    const {categoryList,currentCategory} = yield call(http.getCatalogInitData,{});
    // catelogId非NULL,则刷新当前catelogId分类数据
    if(action.parmas.catelogId){
      const {currentCategory} = yield call(http.getCatalogMsg,{id:action.parmas.catelogId});
      yield put({
        type: actionTypes.CATALOG_INITDATA_GETDATA_SUCCESS,
        activeCatalogMsg: currentCategory,
        cateLogList:categoryList,
      })
    }else{
      yield put({
        type: actionTypes.CATALOG_INITDATA_GETDATA_SUCCESS,
        cateLogList:categoryList,
        activeCatalogMsg: currentCategory
      })
    }
  } catch (err) {
    yield put({
      type: actionTypes.CATALOG_INITDATA_GETDATA_FAILURE,
    })
  }
}

export function* catalogMsg(action) {
  try {
    const data = yield call(http.getCatalogMsg,action.parmas);
    const {currentCategory} = data
    yield put({
      type: actionTypes.CATALOG_CATALOGMSG_GETDATA_SUCCESS,
      activeCatalogMsg: currentCategory
    })
  } catch (err) {
    yield put({
      type: actionTypes.CATALOG_CATALOGMSG_GETDATA_FAILURE,
    })
  }
}

export default function* root() {
  yield all([
    takeLatest(actionTypes.CATALOG_INITDATA_GETDATA_REQUEST, requestBefore(catalogInit)),
    takeLatest(actionTypes.CATALOG_CATALOGMSG_GETDATA_REQUEST, requestBefore(catalogMsg))
  ]);
}