import actionTypes from '../actions/actionTypes'

const initState = {
  topicDetail: {},
  topicComment: [],
  topicCommentCount: 0,
  topicRelateds: []
}
export default function topicDetail(state = initState,action) {
  const {topicDetail, topicComment, topicRelateds, type, topicCommentCount} = action
  switch (type){
    case actionTypes.TOPOICDETAIL_GETDATA_SUCCESS: return {topicDetail,topicComment, topicCommentCount, topicRelateds};
    case actionTypes.TOPOICDETAIL_GETDATA_FAILURE: return state;
    default: return state;
  }
}