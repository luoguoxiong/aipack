import ActionsTypes from './actionTypes';

export function fetchData(parmas) {
  return {
    type: ActionsTypes.GOODSSEARCH_GETDATA_REQUEST,
    parmas
  }
}
export function changeParmas(parmas) {
  return {
    type: ActionsTypes.GOODSSEARCH_CHANGE_PARMAS,
    ...parmas
  }
}
export function resetParmas() {
  return {
    type: ActionsTypes.GOODSSEARCH_RESET_STATE
  }
}

export function changeSearchParmas(parmas) {
  return {
    type: ActionsTypes.GOODSSEARCH_CHANGE_SEARCHVAL_PARMAS,
    ...parmas
  }
}

export function changeSortParmas(parmas) {
  return {
    type: ActionsTypes.GOODSSEARCH_CHANGE_SORT_PARMAS,
    ...parmas
  }
}

export function changeCategoryIdParmas(parmas) {
  return {
    type: ActionsTypes.GOODSSEARCH_CHANGE_CATEGORYID_PARMAS,
    ...parmas
  }
}