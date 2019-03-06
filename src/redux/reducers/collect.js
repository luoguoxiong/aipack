import actionTypes from '../actions/actionTypes'

const initState = {
  collect: []
}
export default function home(state = initState,action) {
  switch (action.type){
    case actionTypes.COLLECT_GETDATA_SUCCESS: return {collect:action.data};
    case actionTypes.COLLECT_GETDATA_FAILURE: return state;
    default: return state;
  }
}
