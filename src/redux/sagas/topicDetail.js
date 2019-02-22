import http from '../../http'
import { all, call, put, takeLatest } from 'redux-saga/effects';
import actionTypes from '../actions/actionTypes'
import {requestBefore} from './request'
export function* topicDetail(action) {
  try {
    const detailData = yield call(http.getTopicDetail,{id: action.id});
    const relatedData = yield call(http.getTopicDetailRelated,{id: action.id});
    const commentData = yield call(http.getCommentList,{valueId: action.id, typeId: 1, size: 5, page: 1});
    yield put({
      type: actionTypes.TOPOICDETAIL_GETDATA_SUCCESS,
      topicDetail:detailData,
      topicRelateds:relatedData,
      topicCommentCount: commentData.count,
      topicComment: commentData.data
    })
  } catch (err) {
    yield put({
      type: actionTypes.TOPOICDETAIL_GETDATA_FAILURE,
    })
  }
}

export default function* root() {
  yield all([
    takeLatest(actionTypes.TOPOICDETAIL_GETDATA_REQUEST, requestBefore(topicDetail))
  ]);
}