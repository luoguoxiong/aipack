import actionTypes from '../actions/actionTypes'

const initState = {
  brandDetail: {},
}
export default function brand(state = initState,action) {
  const{brandDetail,type} = action
  switch (type){
    case actionTypes.BRAND_DETAIL_GETDATA_SUCCESS: return {...state,brandDetail:{...brandDetail}};
    case actionTypes.BRAND_DETAIL_GETDATA_FAILURE: return state;
    default: return state;
  }
}