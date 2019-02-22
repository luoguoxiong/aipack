import ActionsTypes from './actionTypes';

export function fetchBrandDetail(parmas) {
  return {
    type: ActionsTypes.BRAND_DETAIL_GETDATA_REQUSET,
    parmas
  }
}