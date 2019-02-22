import http from '../../http'
import { all, call, put, takeLatest } from 'redux-saga/effects';
import actionTypes from '../actions/actionTypes'
import { requestBefore } from "./request";
export function* brandGoods(action) {
  try {
    yield put({
      type: actionTypes.BRAND_DETAIL_GETDATA_SUCCESS,
      brandDetail:{name:'制造商详情'}
    })
    const data = yield call(http.getBrandDetail,action.parmas);
    yield put({
      type: actionTypes.BRAND_DETAIL_GETDATA_SUCCESS,
      brandDetail:data.brand
    })
  } catch (err) {
    yield put({
      type: actionTypes.BRAND_DETAIL_GETDATA_FAILURE,
    })
  }
}

export default function* root() {
  yield all([
    takeLatest(actionTypes.BRAND_DETAIL_GETDATA_REQUSET, requestBefore(brandGoods))
  ]);
}