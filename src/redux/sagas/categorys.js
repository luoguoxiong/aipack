import http from '../../http'
import { all, call, put, takeLatest } from 'redux-saga/effects';
import actionTypes from '../actions/actionTypes'
import { requestBefore } from "./request";
export function* categorysNav(action) {
  try {
    const data = yield call(http.getCategoryNavData,action.parmas);
    yield put({
      type: actionTypes.CATAGORY_NAV_GETDATA_SUCCESS,
      ...data
    })
  } catch (err) {
    yield put({
      type: actionTypes.CATAGORY_NAV_GETDATA_FAILURE,
    })
  }
}

export default function* root() {
  yield all([
    takeLatest(actionTypes.CATAGORY_NAV_GETDATA_REQUEST, requestBefore(categorysNav))
  ]);
}