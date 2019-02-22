import { put } from 'redux-saga/effects';

import ActionsTypes from '../actions/actionTypes';
// import api from '../../constants/Api/api';
// import request from '../../constants/Api/request';
export function requestBefore(callback) {
  return function*(params) {
    yield put({
      type: ActionsTypes.LOADING_START,
    });
    if (callback) {
      yield* callback(params);
      window.scrollTo(0,0)
    }
    yield put({
      type: ActionsTypes.LOADING_END,
    });
  }
}