import ActionsTypes from './actionTypes';

export function fetchCount(parmas) {
  return {
    type: ActionsTypes.GOODS_COUNT_GETDATA_REQUSET,
    parmas
  }
}
export function fetchGoodsData(parmas) {
  return {
    type: ActionsTypes.GOODS_LIST_GETDATA_REQUSET,
    parmas
  }
}