import actionTypes from '../actions/actionTypes'

const initState = {
  currentCategory:{},
  brotherCategory: []
}
export default function categorys(state = initState,action) {
  const{type,brotherCategory,currentCategory} = action
  switch (type){
    case actionTypes.CATAGORY_NAV_GETDATA_SUCCESS: return {...state,currentCategory,brotherCategory};
    case actionTypes.CATAGORY_NAV_GETDATA_FAILURE: return state;
    default: return state;
  }
}