import ActionsTypes from './actionTypes';

export function fetchInitData(parmas) {
  return {
    type: ActionsTypes.CATALOG_INITDATA_GETDATA_REQUEST,
    parmas
  }
}

export function fetchCatelogMsg(parmas) {
  return {
    type: ActionsTypes.CATALOG_CATALOGMSG_GETDATA_REQUEST,
    parmas
  }
}

export function changeIdAndTabIndex(parmas) {
  return {
    type: ActionsTypes.CATALOG_CHANGEIDANDTABINDEX,
    ...parmas
  }
}