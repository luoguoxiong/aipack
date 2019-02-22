import actionTypes from '../actions/actionTypes'

const initState = {
  cateLogList: [],
  activeCatalogMsg: {},
  catelogId: null,
  tabIndex: 0
}
export default function catalog(state = initState,action) {
  const{activeCatalogMsg,cateLogList,type,catelogId,tabIndex} = action
  switch (type){
    case actionTypes.CATALOG_INITDATA_GETDATA_SUCCESS: return {...state,cateLogList,activeCatalogMsg};
    case actionTypes.CATALOG_INITDATA_GETDATA_FAILURE: return state
    case actionTypes.CATALOG_CATALOGMSG_GETDATA_SUCCESS: return {...state,activeCatalogMsg};
    case actionTypes.CATALOG_CATALOGMSG_GETDATA_FAILURE: return state
    case actionTypes.CATALOG_CHANGEIDANDTABINDEX: return{...state,catelogId,tabIndex}
    default: return state;
  }
}