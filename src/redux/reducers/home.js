import actionTypes from '../actions/actionTypes'

const initState = {
  banner:[],
  channel: [],
  newGoodsList: [],
  hotGoodsList: [],
  brandList: [],
  topicList: [],
  categoryList: [],
  isSuccess: false
}
export default function home(state = initState,action) {
  switch (action.type){
    case actionTypes.HOME_GETDATA_SUCCESS: return {...action.data,isSuccess: true};
    case actionTypes.HOME_GETDATA_FAILURE: return {...state,isSuccess: false};
    default: return state;
  }
}