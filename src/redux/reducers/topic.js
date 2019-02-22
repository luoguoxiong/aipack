import actionTypes from '../actions/actionTypes'

const initState = {
  topicData: [],
  totalCount: 0
}
export default function topic(state = initState,action) {
  const {topicData, totalCount, type} = action
  switch (type){
    case actionTypes.TOPIC_GETDATA_SUCCESS: return {...state,topicData,totalCount};
    case actionTypes.TOPIC_GETDATA_FAILURE: return state;
    default: return state;
  }
}