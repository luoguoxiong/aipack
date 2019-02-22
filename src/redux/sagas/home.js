import http from '../../http'
import { all, call, put, takeLatest } from 'redux-saga/effects';
import actionTypes from '../actions/actionTypes'
import { requestBefore } from "./request";
export function* home() {
  try {
    const data = yield call(http.getHomeData,{});
    yield put({
      type: actionTypes.HOME_GETDATA_SUCCESS,
      data
    })
  } catch (err) {
    yield put({
      type: actionTypes.HOME_GETDATA_FAILURE,
    })
  }
}

export default function* root() {
  yield all([
    takeLatest(actionTypes.HOME_GETDATA_REQUEST, requestBefore(home))
  ]);
}