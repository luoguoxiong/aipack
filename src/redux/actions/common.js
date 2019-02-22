import ActionsTypes from './actionTypes';

export function startLoading() {
  return {
    type: ActionsTypes.LOADING_START,
  }
}

export function endLoading() {
  return {
    type: ActionsTypes.LOADING_END,
  }
}

export function loginSuccess() {
  return {
    type: ActionsTypes.CHECK_LOGIN_SUCCESS,
  }
}

export function loginFailure() {
  return {
    type: ActionsTypes.CHECK_LOGIN_FAILURE,
  }
}




