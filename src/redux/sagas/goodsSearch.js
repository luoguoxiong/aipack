import http from '../../http'
import { all, call, put, takeLatest } from 'redux-saga/effects';
import actionTypes from '../actions/actionTypes'
import { requestBefore } from "./request";
export function* getGoodsList({parmas}) {
  try {
    const {searchVal,size,page, sortType, priceSortStatus, searchCategoryId, searchCategoryList } = parmas
    const {data, filterCategory} = yield call(http.getGoodsData,{
        keyword: searchVal,
        page,
        size,
        sort: sortType === 1 ? 'id': 'price',
        order: priceSortStatus > 0 ? 'asc': priceSortStatus === 0 ? 'default' : 'desc',
        categoryId: searchCategoryId
      });
    yield put({
      type: actionTypes.GOODSSEARCH_GETDATA_SUCCESS,
      goodsList: data,
      searchCategoryList: searchCategoryList? searchCategoryList: filterCategory,
      searchCategoryId: searchCategoryList?searchCategoryId: filterCategory[0].id
    })
  } catch (err) {
    yield put({
      type: actionTypes.GOODSSEARCH_GETDATA_FAILURE,
    })
  }
}
export default function* root() {
  yield all([
    takeLatest(actionTypes.GOODSSEARCH_GETDATA_REQUEST, requestBefore(getGoodsList)),
  ]);
}