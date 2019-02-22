import http from '../../http'
import { all, call, put, takeLatest } from 'redux-saga/effects';
import actionTypes from '../actions/actionTypes'
import {requestBefore} from './request'
export function* comment({id, page, size, typeId}) {
  try {
    const commentData = yield call(http.getCommentList,{valueId: id, typeId, size, page});
    yield put({
      type: actionTypes.COMMENT_GETDATA_SUCCESS,
      comment: commentData.data,
      comentCount: commentData.count
    })
  } catch (err) {
    yield put({
      type: actionTypes.COMMENT_GETDATA_FAILURE,
    })
  }
}

export default function* root() {
  yield all([
    takeLatest(actionTypes.COMMENT_GETDATA_REQUEST, requestBefore(comment))
  ]);
}