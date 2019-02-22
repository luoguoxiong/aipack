import ActionsTypes from './actionTypes';

export function fetchData(parmas) {
  return {
    type: ActionsTypes.TOPIC_GETDATA_REQUEST,
    parmas
  }
}