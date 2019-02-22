import http from '../../http'
import { all, call, put, takeLatest } from 'redux-saga/effects';
import actionTypes from '../actions/actionTypes'
import { requestBefore } from "./request";
export function* sellCount() {
  try {
    const data = yield call(http.getSellGoodsCount,{});
    const {goodsCount} = data
    yield put({
      type: actionTypes.GOODS_COUNT_GETDATA_SUCCESS,
      count: goodsCount
    })
  } catch (err) {
    yield put({
      type: actionTypes.GOODS_COUNT_GETDATA_FAILURE,
    })
  }
}

export function* goodsList(action) {
  try {
    const data = yield call(http.getGoodsData,action.parmas);
    yield put({
      type: actionTypes.GOODS_LIST_GETDATA_SUCCESS,
      goodsList: data.goodsList
    })
  } catch (err) {
    yield put({
      type: actionTypes.GOODS_LIST_GETDATA_FAILURE,
    })
  }
}

export default function* root() {
  yield all([
    takeLatest(actionTypes.GOODS_COUNT_GETDATA_REQUSET, requestBefore(sellCount)),
    takeLatest(actionTypes.GOODS_LIST_GETDATA_REQUSET, requestBefore(goodsList))
  ]);
}