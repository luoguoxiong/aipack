import ActionsTypes from './actionTypes';

export function fetchNavData(parmas) {
  return {
    type: ActionsTypes.CATAGORY_NAV_GETDATA_REQUEST,
    parmas
  }
}