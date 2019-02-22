import actionTypes from '../actions/actionTypes'

const initState = {
  /*
  *  sortType: 排序： 1：默认排序，2： 按价格
  *  searchVal: 输入框的值
  *  page: 页数
  *  size：每页的数量
  *  priceSortStatus: 排序 ： 1、升序；2、降序
  *  searchCategoryId: 查询分类id
  *  goodsList: 查询的商品
  *  searchCategoryList: 查询可选分类
  * */
  searchCategoryList: [],
  searchVal: '',
  sortType: 1,
  page: 1,
  size: 100,
  priceSortStatus: 0,
  searchCategoryId: 0,
  goodsList: []
}
export default function goodsSearch(state=initState, action) {
  const {searchCategoryList, searchCategoryId, goodsList, searchVal,sortType,page,size, priceSortStatus, type} = action
  switch (type){
    case actionTypes.GOODSSEARCH_GETDATA_SUCCESS: return {...state, searchCategoryList, goodsList, searchCategoryId}
    case actionTypes.GOODSSEARCH_GETDATA_FAILURE: return state
    case actionTypes.GOODSSEARCH_RESET_STATE: return {...initState}
    case actionTypes.GOODSSEARCH_CHANGE_SEARCHVAL_PARMAS: return {...state, searchVal, page: 1, size: 100}
    case actionTypes.GOODSSEARCH_CHANGE_SORT_PARMAS: return {...state, sortType, priceSortStatus, page: 1, size: 100}
    case actionTypes.GOODSSEARCH_CHANGE_CATEGORYID_PARMAS: return {...state, searchCategoryId, page: 1, size: 100}
    case actionTypes.GOODSSEARCH_CHANGE_PARMAS: return {goodsList, searchCategoryList, searchVal, sortType, page, size, priceSortStatus, searchCategoryId}
    default: return state
  }
}