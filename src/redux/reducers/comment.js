import actionTypes from '../actions/actionTypes'

const initState = {
  comment: [],
  comentCount: 0
}
export default function comment(state = initState,action) {
  const {comment,comentCount, type } = action
  switch (type){
    case actionTypes.COMMENT_GETDATA_SUCCESS: return {comment, comentCount};
    case actionTypes.COMMENT_GETDATA_FAILURE: return state;
    default: return state;
  }
}