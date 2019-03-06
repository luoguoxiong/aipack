import ActionsTypes from './actionTypes';

export function fetchData() {
  return {
    type: ActionsTypes.COLLECT_GETDATA_REQUSET
  }
}

export function apdateData(data) {
  return {
    type: ActionsTypes.COLLECT_GETDATA_SUCCESS,
    data
  }
}
