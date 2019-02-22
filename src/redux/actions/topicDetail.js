import ActionsTypes from './actionTypes';

export function fetchData(id) {
  return {
    type: ActionsTypes.TOPOICDETAIL_GETDATA_REQUEST,
    id
  }
}