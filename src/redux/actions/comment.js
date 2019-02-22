import ActionsTypes from './actionTypes';

export function fetchData({id, page, size, typeId}) {
  return {
    type: ActionsTypes.COMMENT_GETDATA_REQUEST,
    page,
    size,
    typeId,
    id
  }
}