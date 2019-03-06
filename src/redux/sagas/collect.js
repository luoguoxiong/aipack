import http from '../../http'
import { all, call, put, takeLatest } from 'redux-saga/effects';
import actionTypes from '../actions/actionTypes'
import { requestBefore } from "./request";
export function* collect() {
  try {
    const data = yield call(http.getLikes,{typeId:0,size: 1000});
    data.forEach((item) => {
      item.isClose = true
    })
    yield put({
      type: actionTypes.COLLECT_GETDATA_SUCCESS,
      data
    })
  } catch (err) {
    yield put({
      type: actionTypes.COLLECT_GETDATA_FAILURE,
    })
  }
}

export default function* root() {
  yield all([
    takeLatest(actionTypes.COLLECT_GETDATA_REQUSET, requestBefore(collect))
  ]);
}
